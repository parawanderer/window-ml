// capture-frames.mjs — a CAPTURE PROBE, not a test.
//
//   node --import tsx tests/e2e/capture-frames.mjs > tests/e2e/fixtures/events-<name>.json
//
// Connects straight to the real box's event stream (the .env backend) and dumps the retained ring as JSON,
// so a fixture is a RECORDING rather than a guess. Everything else that drives the stream replays frames
// this repo also wrote, which is a closed loop — and the closed loop is precisely what hid the bug that
// motivated this: the server names models fully-qualified (`registry.ollama.ai/library/gemma4:31b`) while
// `/api/ps` names them short (`gemma4:31b`), so a hand-written fixture agreed with itself and shipped a
// panel that drew every model twice.
//
//   SECS=20        how long to hold the connection open (default 10)
//   SINCE=600000   how much retained history to ask for, in ms (a DURATION, not an offset)
//
// The stream is idle-cadenced at 15s, so a short capture on a quiet box is mostly backfill — which is the
// interesting part anyway. Not in CI: the backend is live and only a patched Ollama serves this route.
import fs from "node:fs";
import { loadDotEnv } from "../helpers.js";

loadDotEnv();
const { OPENWEBUI_URL: url, OPENWEBUI_KEY: key } = process.env;
if (!url) { console.error("no OPENWEBUI_URL in .env — this probe needs a real backend"); process.exit(1); }

const ac = new AbortController();
// A bounded read, and the bound has to be a TIMER rather than a clock checked after each frame: the idle
// cadence is 15s, so a deadline tested inside the read loop overshoots by up to a heartbeat.
setTimeout(() => ac.abort(), Number(process.env.SECS || 10) * 1000);
const out = [];
try {
    const res = await fetch(`${url}/ollama/api/events?since=${Number(process.env.SINCE || 600_000)}`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: ac.signal,
    });
    const ct = res.headers.get("content-type") || "";
    // A stock server answers an unknown route with the SPA's HTML at 200 — say so, rather than writing a
    // fixture full of parse failures.
    if (!/ndjson/.test(ct)) { console.error(`this backend does not serve the event stream (${res.status}, ${ct})`); process.exit(2); }
    const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.trim()) out.push(JSON.parse(line));
        }
    }
} catch (e) { if (e.name !== "AbortError") { console.error(e.message); process.exit(1); } }

const kinds = {};
for (const f of out) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
console.error(`${out.length} frames  ${JSON.stringify(kinds)}`);
// `hello` is per-connection and the replayer mints its own, so it is not part of a fixture.
// Two-space indent and a trailing newline: the repo's format check applies to a committed fixture like any
// other file, and a probe whose output cannot be committed without a reformat is a probe with a footgun.
fs.writeFileSync(1, `${JSON.stringify(out.filter((f) => f.kind !== "hello"), null, 2)}\n`);
