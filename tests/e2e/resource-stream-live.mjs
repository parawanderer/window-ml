// resource-stream-live.mjs — a DEBUG PROBE, not a test.
//
//   npm run build && node --import tsx tests/e2e/resource-stream-live.mjs
//
// Drives the built extension against the REAL backend in .env and reports whether the resource panel is being
// fed by the server's event stream or by the poll. Everything else that exercises this path drives frames
// this repo also wrote, which is a closed loop; this is the only thing that touches the real service-worker
// fetch, the chrome-extension:// origin, the real auth header, and frames a server we did not write produced.
//
// Not in CI: the backend is live, and only a PATCHED Ollama serves /api/events at all (docs/FORKED-BACKENDS.md).
// A stock server is a valid outcome here, not a failure — it should read "unsupported" and fall back to polling.
//
//   SECONDS=45   how long to watch (default 20)
//   HOLD=1       keep the browser OPEN at the end instead of tearing down, so a human can watch the lane
//                fill in (close the window, or Ctrl+C, to exit). Implies headful.
//   HEADFUL=1    show the browser without holding it open
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { loadDotEnv } from "../helpers.js";

loadDotEnv();   // populates process.env from .env; it returns nothing
const { OPENWEBUI_URL: url, OPENWEBUI_KEY: key, OPENWEBUI_MODEL: model } = process.env;
if (!url) { console.error("no OPENWEBUI_URL in .env — this probe needs a real backend"); process.exit(1); }
const SECONDS = Number(process.env.SECONDS || 20);

const HOLD = process.env.HOLD === "1";
const ext = await launchExtension({ headful: HOLD || process.env.HEADFUL === "1" });
try {
    await configureExtension(ext.sw, {
        chatUrl: `${url}/api/chat/completions`, apiKey: key || "", apiFormat: "openai",
        model: model || "", debugMode: "overlay",
    });
    const page = await ext.context.newPage();
    await page.goto("https://example.com/");
    await waitForMl(page);
    // Open the panel: the stream is subscribed by the app, and the whole design is that nothing connects
    // while nobody is looking.
    // Slide the shell OPEN — the same way the panel spec does. Posting to the page window is not enough: the
    // shell owns the container, so the host has to be given a width and the `open` class, and the message has
    // to reach the IFRAME. A collapsed panel's buttons exist but are not clickable.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = "460px";
        panel.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    const frame = await (async () => {
        for (let i = 0; i < 100; i++) {
            const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
            if (f) return f;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("the sidebar iframe never appeared");
    })();
    // Drive the toggle to a KNOWN state rather than clicking blind — swallowing a failed click here would
    // report "0 tracks" for a panel that was never opened, which reads as the stream not feeding it.
    for (let i = 0; i < 5 && !(await frame.locator(".vram").count()); i++) {
        await frame.locator('[aria-label="VRAM monitor"]').click();
        await page.waitForTimeout(400);
    }
    if (!(await frame.locator(".vram").count())) throw new Error("couldn't open the VRAM panel");

    const read = () => ext.sw.evaluate(() => globalThis.__mlResourceStream?.status?.() ?? null);
    console.log(`\n  watching ${url} for ${SECONDS}s\n`);
    let last = null;
    for (let i = 0; i < SECONDS; i++) {
        const st = await read();
        if (!st) { console.log("  (the worker has no stream handle — is this build current?)"); break; }
        // What the PANEL has, beside what the worker has: frames arriving and readings landing are different
        // failures, and they look identical from either side alone.
        const drawn = await frame.evaluate(() => ({
            // The number of POLYLINES never changes as samples land (same series either way) — count the
            // POINTS in one, which is what actually says whether the chart is advancing.
            pts: (document.querySelector(".rc-area polyline")?.getAttribute("points") || "").split(" ").filter(Boolean).length,
            segs: document.querySelectorAll(".rc-seg").length,
            evs: document.querySelectorAll(".rc-ev").length,
            rows: document.querySelectorAll(".vram-row").length,
        })).catch(() => ({ pts: -1, segs: -1, evs: -1, rows: -1 }));
        const line = `  t=${String(i).padStart(3)}s  frames=${String(st.frames).padStart(3)}  samples=${String(st.samples).padStart(3)}  | chart points=${drawn.pts} segs=${drawn.segs} evs=${drawn.evs} rows=${drawn.rows}${st.note ? `  note=${st.note}` : ""}`;
        if (line !== last) { console.log(line); last = line; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    const st = await read();
    console.log("\n  ---");
    if (st?.unsupported) {
        console.log("  This server does NOT serve /api/events — the panel is polling, which is the correct");
        console.log("  fallback for a stock Ollama. See docs/FORKED-BACKENDS.md.");
    } else if (st?.frames) {
        console.log(`  The stream IS carrying: ${st.frames} frames, ${st.samples} of them samples.`);
        console.log(`  Kinds seen: ${JSON.stringify(st.kinds)}`);
        // Edges are the whole reason for the stream — a poll can see residency but never a load, since for
        // most of a load there is no runner object in the server to observe.
        const edges = Object.keys(st.kinds).filter((k) => k !== "sample" && k !== "heartbeat" && k !== "hello");
        console.log(edges.length
            ? `  EDGES arrived: ${edges.join(", ")} — this is what polling cannot see.`
            : "  No edges yet — nothing loaded or evicted while watching. Load a model to see load.start/complete.");
    } else {
        console.log(`  No frames arrived. note=${st?.note ?? "(none)"}`);
    }
    // What the panel DREW, which is the other half: frames arriving is not the same as samples landing.
    // Frames ARRIVING is not the same as readings LANDING: the panel draws from the samples it applied and
    // from the capacity it learned, so report both halves separately or a fault in one looks like the other.
    const drew = await frame.evaluate(() => ({
        tracks: document.querySelectorAll(".rc-track").length,
        rows: document.querySelectorAll(".vram-row").length,
        noCeiling: !!document.querySelector(".vram-nocap"),
    }));
    console.log(`  panel: ${drew.tracks} tracks, ${drew.rows} model rows${drew.noCeiling ? ", NO CEILING (capacity never landed)" : ""}`);
    // The three things the edges exist to answer, as the lane actually drew them.
    const lane = await frame.evaluate(() => [...document.querySelectorAll(".rc-ev")].map((el) => ({
        kind: [...el.classList].find((c) => c.startsWith("rc-ev-"))?.slice(6),
        title: el.getAttribute("aria-label") || el.title || "",
        // A composite span's phases are drawn as a GRADIENT with hard stops, not as child elements — so the
        // evidence that a divider exists is the number of colour stops in the inline background.
        bg: (el.getAttribute("style") || "").replace(/\s+/g, " ").slice(0, 120),
        // The load's interior divider is an overlay element, not a gradient stop.
        parts: [...el.children].map((c) => `${c.className}@${(c.getAttribute("style") || "").replace(/\s+/g, " ")}`),
    })));
    // The chips COUNT what the timeline holds, before the lane filters it — so a chip that says "loads 4"
    // beside an empty lane separates "the events never arrived" from "they were filtered or placed out of
    // the window", which look identical from the drawn output alone.
    const chips = await frame.evaluate(() => ({
        chips: [...document.querySelectorAll(".rc-lane-chip")].map((c) => c.textContent.trim()),
        lanePresent: !!document.querySelector(".rc-lane"),
        count: document.querySelector(".rc-lane-count")?.textContent || "",
    }));
    // A picture of the panel, since a count cannot show a line that is drawn WRONG — only one that is absent.
    try {
        const shot = "tests/e2e/artifacts/stream-live-panel.png";
        await frame.locator(".vram").screenshot({ path: shot });
        console.log(`  screenshot: ${shot}`);
    } catch (e) { console.log(`  (no screenshot: ${e.message})`); }
    console.log(`  lane section: ${chips.lanePresent ? "present" : "ABSENT"}  chips: ${chips.chips.join(" · ") || "(none)"}  shown: ${chips.count || "all"}`);
    const loads = lane.filter((e) => e.kind === "load"), serves = lane.filter((e) => e.kind === "serve");
    console.log(`  lane: ${lane.length} spans — ${loads.length} load, ${serves.length} serving`);
    for (const l of loads) console.log(`    load  ${l.bg}\n          divider: ${l.parts.join(" ") || "NONE — no boundary reported for this load"}`);
    for (const v of serves) console.log(`    serve ${v.title}\n          ${v.bg}`);
    if (HOLD) {
        console.log("\n  holding the browser open — the lane keeps filling as the box loads and serves.");
        console.log("  Close the window (or Ctrl+C) when you are done.\n");
        await new Promise(() => { /* until the window closes or the process is killed */ });
    }
} finally {
    if (!HOLD) await ext.close();
}
