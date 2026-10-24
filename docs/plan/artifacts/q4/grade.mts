// Spike Q4: grade the panel's artifacts against the dialect: parse every script, run the `data` ones in a prototype
// artifact realm (Q3) with events fired at every handler, and tally refusals by construct.
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { Evaluator, runAsync } from "../../../../src/readonly-exec/evaluator";
import { Parser } from "../../../../src/readonly-exec/parser";
import { tokenize } from "../../../../src/readonly-exec/tokenizer";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "replies");
const CSV = "month,mm\nJan,78\nFeb,61\nMar,55\nApr,49\nMay,52\nJun,60\nJul,71\nAug,80\nSep,66\nOct,88\nNov,95\nDec,84";
const CURRENT = () => {
    const messages = [
        { role: "system", content: "You are window.ml." },
        { role: "user", content: "Plan my weekend trip and track it." },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com\"}" } }] },
        { role: "tool", content: "The page says: weather is fine." },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "python_exec", arguments: "{}" } }, { function: { name: "artifact", arguments: "{}" } }] },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "Here is the plan, with a todo list beside it." },
    ];
    return { messages, meta: messages.map(() => ({})), log: Object.assign([], { text: "" }), run: { id: "r1" } };
};

/** Why a script was refused, as a construct name, so refusals can be tallied across models. */
function construct(msg: string): string {
    let m;
    if ((m = /^'(\w+)' is not available/.exec(msg))) return `'${m[1]}' not available`;
    if ((m = /method '(\w+)' not allowed on (\w+)/.exec(msg))) return `method .${m[1]}() on ${m[2]}`;
    if ((m = /method '(\w+)' not allowed/.exec(msg))) return `method .${m[1]}()`;
    if (/only shorthand `\{ a, b \}` destructuring/.test(msg)) return "destructuring rename/default";
    if (/expected `of` in a for-loop/.test(msg)) return "for(;;)";
    if (/for…in/.test(msg)) return "for…in";
    if (/can only assign to an object or array you built/.test(msg)) return "write to a non-owned object";
    if (/can only mutate an array you created/.test(msg)) return "mutate a non-owned array";
    if (/too much work/.test(msg)) return "step budget";
    return msg.replace(/\d+/g, "N").slice(0, 90);
}

/** The body's HTML as the plain-data view the `data` shape promises: {tag, attrs, text, children}, plus byId. */
function viewOf(body: string) {
    const doc = new JSDOM(`<body>${body}</body>`).window.document;
    const byId: Record<string, unknown> = {};
    const walk = (el: Element): Record<string, unknown> => {
        const attrs = Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value]));
        const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
        const node: Record<string, unknown> = { tag: el.tagName.toLowerCase(), attrs, text, children: Array.from(el.children).map(walk) };
        if (attrs.id) byId[attrs.id] = node;
        return node;
    };
    const root = walk(doc.body);
    root.tag = "root";
    root.byId = byId;
    return root;
}

/** Every handler in a view tree: [node id or tag, event type, fn]. */
function handlers(node: any, out: [string, string, Function][] = [], seen = new Set()): [string, string, Function][] {
    if (!node || typeof node !== "object" || seen.has(node)) return out;
    seen.add(node);
    if (node.on && typeof node.on === "object") for (const [t, f] of Object.entries(node.on)) if (typeof f === "function") out.push([node.attrs?.id ?? node.tag, t, f as Function]);
    for (const c of node.children ?? []) handlers(c, out, seen);
    return out;
}

/** Run a `data` artifact's scripts, then fire two rounds of events at its handlers. */
async function runData(art: any) {
    const ev: any = new Evaluator(null, 3_000_000, "worker");
    const env: any = Object.assign(Object.create(null), { Array, Object, JSON, Math, String, Number, Boolean, Promise, Date, parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity, console: { log() { }, warn() { }, error() { }, info() { } } });
    const ml: any = Object.create(null);
    ml.current = ev.adoptCurrent(CURRENT());
    ml.dereference = (ref: string) => (/7be01d4/.test(ref) ? CSV : `no such result ${ref}`);
    ev.ml = ml;
    env.ml = ml;
    env.state = ev.ownedCopy({});
    env.root = ev.ownedCopy(viewOf(art.body ?? ""));
    const errors: { where: string; msg: string }[] = [];
    for (const [i, src] of (art.scripts ?? []).entries()) {
        try { await runAsync(ev.eval(new Parser(tokenize(src)).parseProgram(), Object.create(env))); }
        catch (e: any) { errors.push({ where: `script ${i}`, msg: e.message }); }
    }
    const hs = handlers(env.root);
    let fired = 0;
    for (let round = 0; round < 2; round++) for (const [id, type, fn] of handlers(env.root)) {
        const e = { type, id, value: "buy snacks", checked: true, key: "Enter", target: { value: "buy snacks", checked: true, id } };
        ev.fuel = 200_000;
        fired++;
        try { await runAsync(ev.callOwn(fn, [ev.ownedCopy(e)])); } catch (err: any) { errors.push({ where: `${type} on ${id}`, msg: err.message }); }
    }
    const text: string[] = [];
    const walk = (n: any, seen = new Set()) => { if (!n || typeof n !== "object" || seen.has(n)) return; seen.add(n); if (n.text != null) text.push(String(n.text)); if (n.attrs?.value) text.push(String(n.attrs.value)); for (const c of n.children ?? []) walk(c, seen); };
    walk(env.root);
    return { errors, handlers: hs.length, fired, state: JSON.stringify(env.state).slice(0, 400), text: text.join(" ") };
}

// The DOM names the `dom` shape offered, plus every builtin method a script may call on its own values: what is left
// over is a DOM method a script reached for that the facade did not promise.
const DOM_OK = new Set(["querySelector", "querySelectorAll", "classList", "add", "remove", "toggle", "setAttribute", "getAttribute", "append", "replaceChildren", "create", "addEventListener", "dereference",
    ...Object.getOwnPropertyNames(Array.prototype), ...Object.getOwnPropertyNames(String.prototype), ...Object.getOwnPropertyNames(Number.prototype), ...Object.getOwnPropertyNames(Object), ...Object.getOwnPropertyNames(Math),
    ...Object.getOwnPropertyNames(Number), ...Object.getOwnPropertyNames(Array), ...Object.getOwnPropertyNames(JSON), ...Object.getOwnPropertyNames(Map.prototype), ...Object.getOwnPropertyNames(Set.prototype), ...Object.getOwnPropertyNames(Date.prototype),
    "isNaN", "parseInt", "parseFloat", "isFinite", "String", "Number", "Boolean"]);
const rows: any[] = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".json")).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    const fence = /```json\s*([\s\S]*?)```/.exec(r.text) ?? /(\{[\s\S]*\})/.exec(r.text);
    let art: any = null;
    try { art = JSON.parse(fence?.[1] ?? ""); } catch { }
    const row: any = { model: r.model, shape: r.shape, task: r.task, json: !!art, scripts: art?.scripts?.length ?? 0, lines: (art?.scripts ?? []).join("\n").split("\n").length, parse: [] as string[], run: [] as string[] };
    if (art) {
        for (const [i, src] of (art.scripts ?? []).entries()) { try { new Parser(tokenize(src)).parseProgram(); } catch (e: any) { row.parse.push(construct(e.message)); } }
        if (r.shape === "data") { const d = await runData(art); row.run = d.errors.map((e) => construct(e.msg)); row.handlers = d.handlers; row.fired = d.fired; row.state = d.state; row.runRaw = d.errors;
            // Did it get the answer right, not only run? Each task's check reads the view (or, for the todo, the state).
            const RIGHT: Record<string, () => boolean> = {
                figure: () => /Nov/.test(d.text) && /Oct/.test(d.text) && /Dec/.test(d.text) && /839/.test(d.text),
                current: () => /assistant\D{0,4}3\b/i.test(d.text) && /tool\D{0,4}2\b/i.test(d.text) &&/python_exec/.test(d.text) && /fetch_url/.test(d.text),
                todo: () => /buy snacks/.test(d.state),
            };
            row.right = RIGHT[r.task]();
            row.text = d.text.slice(0, 300); }
        else row.domCalls = [...new Set(((art.scripts ?? []).join("\n").match(/\.(\w+)\s*\(/g) ?? []).map((s: string) => s.slice(1).replace(/\s*\($/, "")))].filter((n) => !DOM_OK.has(n));
        row.sanitizer = { script: /<script/i.test(art.body ?? ""), onAttr: /\son\w+=/i.test(art.body ?? ""), url: /url\(|@import/i.test(art.css ?? "") };
    }
    rows.push(row);
}
fs.writeFileSync(path.join(DIR, "../grades.json"), JSON.stringify(rows, null, 2) + "\n");
const tally = (key: "parse" | "run", shape?: string) => {
    const t = new Map<string, number>();
    for (const r of rows) if (!shape || r.shape === shape) for (const c of new Set<string>(r[key])) t.set(c, (t.get(c) ?? 0) + 1);
    return [...t].sort((a, b) => b[1] - a[1]);
};
for (const r of rows) console.log(`${r.model.padEnd(36)} ${r.shape.padEnd(4)} ${r.task.padEnd(8)} json=${r.json ? "y" : "N"} scripts=${r.scripts} lines=${r.lines} parse=[${r.parse.join("; ")}] run=[${r.run.join("; ")}]${r.shape === "data" ? ` handlers=${r.handlers} fired=${r.fired} right=${r.right}` : ` dom+=[${(r.domCalls ?? []).join(",")}]`} ${r.sanitizer && Object.values(r.sanitizer).some(Boolean) ? "SANITIZE:" + JSON.stringify(r.sanitizer) : ""}`);
console.log("\nparse refusals (artifacts hitting each):", tally("parse"));
console.log("run refusals, data shape:", tally("run", "data"));
const clean = (shape: string) => rows.filter((r) => r.shape === shape && r.json && !r.parse.length && !r.run.length).length;
console.log(`\nclean artifacts: data ${clean("data")}/${rows.filter((r) => r.shape === "data").length}, dom (parse only) ${clean("dom")}/${rows.filter((r) => r.shape === "dom").length}`);
