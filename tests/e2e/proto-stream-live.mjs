// A DEBUG PROBE, NOT A TEST — the twin of md-ladder-live.mjs and server-tool-live.mjs.
//
// Everything else about the protobuf path drives frames this repo also wrote, which is a closed loop: it
// proves the decoder agrees with our idea of the encoder. This is the only thing that puts the REAL server's
// bytes through it. It answers three questions a report cannot:
//
//   1. Does the box actually serve `Accept: application/protobuf`, through the proxy, on the URL we use?
//   2. Does a Delta carry TOOL CALLS now, or does the text arrive with the call silently missing?
//   3. How many bytes, against the SSE for the same prompt?
//
// Not in CI — the backend is live and it spends GPU time. Reads .env (USE_ENV style):
//   node --import tsx tests/e2e/proto-stream-live.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createFrameReader } from "../../src/protostream.ts";
import { Frame } from "../../src/proto/chat.gen.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = Object.fromEntries(readFileSync(join(ROOT, ".env"), "utf8").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const BASE = (env.OPENWEBUI_URL || "").replace(/\/+$/, "");
const MODEL = process.env.MODEL || env.OPENWEBUI_MODEL;
const KEY = env.OPENWEBUI_KEY;
// The route the handover names. Overridable, because which one the proxy exposes is the thing in question.
const URL_ = process.env.CHAT_URL || `${BASE}/ollama/v1/chat/completions`;

const TOOLS = [{
    type: "function",
    function: {
        name: "get_weather", description: "Current weather for a city.",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
}];

async function run(label, { proto, tools }) {
    const body = {
        model: MODEL, stream: true,
        messages: [{ role: "user", content: tools ? "What is the weather in Paris? Use the tool." : "Count to five." }],
        ...(tools ? { tools: TOOLS } : {}),
    };
    const res = await fetch(URL_, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
            ...(proto ? { Accept: "application/protobuf" } : {}),
        },
        body: JSON.stringify(body),
    });
    const ctype = res.headers.get("content-type") || "";
    if (!res.ok) { console.log(`${label}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`); return null; }

    let bytes = 0, content = "", reasoning = "", toolCalls = [], frames = 0, ended = null;
    const reader = res.body.getReader();
    if (ctype.includes("application/protobuf")) {
        const fr = createFrameReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            for (const f of fr.push(value)) {
                frames++;
                const m = Frame.decode(f);
                if (m.delta?.content) content += m.delta.content;
                if (m.delta?.reasoning) reasoning += m.delta.reasoning;
                for (const tc of m.delta?.toolCalls || []) toolCalls.push(tc);
                if (m.end) ended = m.end;
            }
        }
        console.log(`${label}: PROTOBUF  ${bytes} bytes, ${frames} frames`
            + `  content=${JSON.stringify(content.slice(0, 40))}`
            + `  reasoning=${reasoning.length}ch  toolCalls=${toolCalls.length}`
            + (ended ? `  finish=${ended.finishReason} in=${ended.promptTokens} out=${ended.completionTokens}` : "  NO End frame"));
        if (fr.pending) console.log(`${label}:   WARNING — ${fr.pending} bytes held: the stream was cut mid-frame`);
        for (const tc of toolCalls.slice(0, 3))
            console.log(`${label}:   tool_call idx=${tc.index} id=${tc.id || "-"} ${tc.function?.name || "?"}(${tc.function?.arguments || ""})`);
    } else {
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            buf += dec.decode(value, { stream: true });
        }
        for (const line of buf.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const p = line.slice(5).trim();
            if (p === "[DONE]") continue;
            try {
                const o = JSON.parse(p), d = o.choices?.[0]?.delta || {};
                if (d.content) content += d.content;
                for (const tc of d.tool_calls || []) toolCalls.push(tc);
            } catch { /* not a frame we read */ }
        }
        console.log(`${label}: SSE (content-type ${ctype.split(";")[0]})  ${bytes} bytes`
            + `  content=${JSON.stringify(content.slice(0, 40))}  toolCalls=${toolCalls.length}`);
    }
    return { bytes, toolCalls: toolCalls.length, content };
}

console.log(`POST ${URL_}\nmodel ${MODEL}\n`);
const sse = await run("text  / sse ", { proto: false, tools: false });
const pb = await run("text  / proto", { proto: true, tools: false });
if (sse && pb) {
    const ratio = pb.bytes ? (sse.bytes / pb.bytes).toFixed(1) : "n/a";
    console.log(`\n  ${sse.bytes} → ${pb.bytes} bytes  (${ratio}x smaller)\n`);
}
// THE QUESTION THAT DECIDES THE GATE. The schema has carried tool_calls all along; what matters is whether
// the ENCODER fills them, because the failure mode if it does not is silent — the text arrives and the call
// simply is not there, which reads as the model choosing not to call one.
await run("tools / sse ", { proto: false, tools: true });
await run("tools / proto", { proto: true, tools: true });
