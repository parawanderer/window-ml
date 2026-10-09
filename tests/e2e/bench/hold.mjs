// hold.mjs — keep a bench cell's run open after its last ask, in a process of its own, so someone can go on talking to it.
//
//   node --import tsx tests/e2e/bench/hold.mjs                list the held runs and how to attach to each
//   node --import tsx tests/e2e/bench/hold.mjs --stop [x]     release them all (or those whose pid, cell or directory has x)
//   node tests/e2e/converse.mjs --attach <cell dir> "…"       the next message to one (converse's inbox/outbox protocol)
//
// A sweep started with `--hold` (run.mjs), or over a task that says `hold`, runs each held cell through `startHeld`: a
// DETACHED child (this file, `--child`) runs the cell and hands the finished run back over IPC, where it is measured like
// any other. When the sweep says to keep it, the child stays up after the sweep exits, with the session, its pointers,
// `ml.current` and the page exactly as the run left them, which a re-seeded run cannot give back (a seed runs its tools
// again). Each held run is an entry in HELD_FILE while it lives, and goes on `/end`, after its idle minutes with no
// message, or on SIGTERM (what `--stop` and merge-when-green send), closing its browser.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSelector, selected } from "./cells.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
/** The runs held open right now, a list of `{ pid, cell, sweep, dir, attach, expiresAt }` (merge-when-green reads it). */
export const HELD_FILE = process.env.BENCH_HELD_FILE || path.join(ROOT, "tests/e2e/artifacts/bench/held.json");   // the env: tests only
/** How long a held run waits for a message before it lets go: a local model's hold keeps its memory on the box. */
export const HOLD_IDLE_MIN = 30;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readAll = () => { try { const l = JSON.parse(fs.readFileSync(HELD_FILE, "utf8")); return Array.isArray(l) ? l : []; } catch { return []; } };
function writeAll(list) {
    if (!list.length) { fs.rmSync(HELD_FILE, { force: true }); return; }
    fs.mkdirSync(path.dirname(HELD_FILE), { recursive: true });
    const tmp = `${HELD_FILE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, HELD_FILE);
}

/** The held runs whose process is still alive. */
export const heldRuns = () => readAll().filter((h) => alive(h.pid));
const putHeld = (entry) => writeAll([...heldRuns().filter((h) => h.pid !== entry.pid), entry]);
const dropHeld = (pid) => writeAll(heldRuns().filter((h) => h.pid !== pid));

/**
 * Whether to hold a cell open: `"always"`, `"failures"` (only a run that errored or was wrong), or null. `cli` is run.mjs's
 * `--hold` list, which wins over the task's own `hold`: `all`, `failures`, and `k=v` selectors as `--only` takes them (a
 * cell must match every selector given).
 */
export function holdMode(cell, cli = []) {
    if (!cli.length) return cell.task.hold === true ? "always" : cell.task.hold === "failures" ? "failures" : null;
    const sel = parseSelector(cli);
    if (sel.length && !selected(cell, sel, [])) return null;
    return cli.includes("failures") ? "failures" : "always";
}

/** A spec file as run.mjs reads it: a `.bench.ts` module, or an interview `.json` over the given models. */
export async function loadSpec(specPath, { models = [], surface, turnMinutes } = {}) {
    if (specPath.endsWith(".json")) {
        const { loadInterview, interviewBench } = await import("../interview.mjs");
        return interviewBench(loadInterview(specPath), models, { surface, turnMinutes });
    }
    const mod = await import(pathToFileURL(path.resolve(specPath)).href);
    return mod.default || mod.spec;
}

/**
 * Run one cell in a detached child that can outlive the sweep. `job` names the cell (spec path, how it was loaded, the
 * selection, its index and key) and carries what runConfig needs; it goes over IPC, never to disk, since the backend in
 * it may carry a key. `onEvent` gets the run's debug events as they come, `onTurns` a call after each interview turn.
 * @returns {{ ran: Promise<{ run: object, statuses: string[] }>, decide: (keep: boolean) => Promise<object | null> }}
 *   `ran` settles with the finished run; `decide` then keeps it (resolving its HELD_FILE entry) or lets it go (null)
 */
export function startHeld(job, { onEvent, onTurns } = {}) {
    fs.mkdirSync(job.dir, { recursive: true });
    const out = fs.openSync(path.join(job.dir, "hold.log"), "a");
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--child"],
        { cwd: ROOT, detached: true, stdio: ["ignore", out, out, "ipc"], serialization: "advanced" });
    fs.closeSync(out);
    let onRun, onHeld = null;
    const ran = new Promise((resolve) => { onRun = resolve; });
    child.on("message", (m) => {
        if (m.type === "event") onEvent?.(m.ev);
        else if (m.type === "turns") onTurns?.();
        else if (m.type === "run") onRun({ run: m.run, statuses: m.statuses ?? [] });
        else if (m.type === "held") onHeld?.(m.entry);
    });
    child.on("exit", (code, signal) => {
        onRun({ run: { events: [], result: null, error: `the held run's process ended (${signal || code}) before its run did; see hold.log`, runMs: 0, approvals: [], seedBoundaryStep: -1 }, statuses: [] });
        onHeld?.(null);
    });
    child.send({ type: "job", job });
    const letGo = () => { child.removeAllListeners(); if (child.connected) child.disconnect(); child.unref(); };
    const decide = (keep) => new Promise((resolve) => {
        if (!child.connected) { resolve(null); return; }
        if (!keep) { child.send({ type: "release" }); letGo(); resolve(null); return; }
        onHeld = (entry) => { letGo(); resolve(entry); };
        child.send({ type: "hold" });
    });
    return { ran, decide };
}

/** The next inbox message (files in name order, each removed once read), or null on `/end` or once `stop()` says so. */
async function nextMessage(inbox, stop) {
    while (!stop()) {
        const files = fs.readdirSync(inbox).filter((f) => !f.startsWith(".")).sort();
        if (files.length) {
            const p = path.join(inbox, files[0]);
            const text = fs.readFileSync(p, "utf8").trim();
            fs.rmSync(p);
            if (!text) continue;
            return text === "/end" ? null : text;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

/** The child: run the cell, hand the run back, and hold it when told to. */
async function child() {
    const job = await new Promise((r) => process.once("message", (m) => r(m.job)));
    const send = (m) => { if (process.connected) try { process.send(m); } catch { /* the sweep is gone */ } };
    const { runOnce } = await import("../run-once.mjs");
    const { expandCells, cellKey, runConfig } = await import("./cells.mjs");
    const { interviewDriver, turnReport } = await import("../interview.mjs");
    const { dir } = job;
    const status = (s) => fs.writeFileSync(path.join(dir, "status"), s + "\n");
    let handed = false, verdict, why = null;
    const decided = new Promise((r) => { verdict = r; });
    process.on("message", (m) => { if (m.type === "hold" || m.type === "release") verdict(m.type); });
    // The sweep gone before it measured this run: nobody is left to read it, so stop now (Playwright closes the browser
    // on exit). Gone after: the verdict was already given.
    process.on("disconnect", () => { if (!handed) process.exit(1); verdict("release"); });
    const release = (sig) => () => {
        why = sig;
        dropHeld(process.pid);
        status(`done: released (${sig})`);
        verdict("release");
        setTimeout(() => process.exit(0), 15_000).unref();   // a turn in flight is not waited for past this
    };
    process.on("SIGTERM", release("SIGTERM"));
    process.on("SIGHUP", release("SIGHUP"));

    try {
        const spec = await loadSpec(job.specPath, job.load);
        const cell = expandCells(spec, job.select)[job.index];
        if (!cell || cellKey(cell, job.fingerprint) !== job.key) throw new Error(`${job.specPath} changed since the sweep started: cell ${job.index} is not the one it asked for`);
        const driver = cell.task.asks?.length ? interviewDriver({ asks: cell.task.asks, dir }) : null;
        const keep = async (run, talk) => {
            handed = true;
            send({ type: "run", run: JSON.parse(JSON.stringify(run)), statuses: driver?.statuses ?? [] });
            if (await decided !== "hold" || why) return;
            const inbox = path.join(dir, "inbox"), outbox = path.join(dir, "outbox");
            for (const d of [inbox, outbox]) fs.mkdirSync(d, { recursive: true });
            const rel = path.relative(ROOT, dir);
            let expiresAt = Date.now() + job.idleMs;
            const entry = () => ({ pid: process.pid, cell: job.label, sweep: job.sweep, dir: rel, attach: `node tests/e2e/converse.mjs --attach ${rel} "<message>"`, expiresAt: new Date(expiresAt).toISOString() });
            putHeld(entry());
            send({ type: "held", entry: entry() });
            const idle = `${Math.round(job.idleMs / 60_000)} idle minutes`;
            status(`held; waiting for inbox (released by /end, after ${idle}, or hold.mjs --stop)`);
            let events = run.events;
            for (;;) {
                const msg = await nextMessage(inbox, () => !!why || Date.now() > expiresAt);
                if (msg == null) { why ||= Date.now() > expiresAt ? idle : "/end"; break; }
                const fromTs = Math.max(0, ...events.map((e) => e.ts ?? 0));
                status(`running a held turn: ${msg.slice(0, 80)}`);
                const t = await talk(msg);
                events = t.events;
                fs.writeFileSync(path.join(outbox, `turn-${t.turn}.md`), turnReport(t.turn, events, fromTs, t.answered ? t.result : null));
                expiresAt = Date.now() + job.idleMs;
                if (why) break;
                putHeld(entry());
                status(`turn ${t.turn} done (outbox/turn-${t.turn}.md); waiting for inbox`);
            }
            dropHeld(process.pid);
            status(`done: released (${why})`);
        };
        await runOnce(runConfig(cell, job.env, dir, {
            onEvent: (ev) => send({ type: "event", ev }),
            ...(driver ? { nextTurn: async (info) => { const next = await driver.nextTurn(info); send({ type: "turns" }); return next; } } : {}),
            keep,
        }));
    } catch (e) {
        console.error(e);
        if (!handed) send({ type: "run", run: { events: [], result: null, error: String(e), runMs: 0, approvals: [], seedBoundaryStep: -1 }, statuses: [] });
    }
    dropHeld(process.pid);
    process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const argv = process.argv.slice(2);
    if (argv[0] === "--child") await child();
    else if (argv[0] === "--stop") {
        const which = heldRuns().filter((h) => !argv[1] || [String(h.pid), h.cell, h.dir].some((s) => String(s).includes(argv[1])));
        for (const h of which) try { process.kill(h.pid, "SIGTERM"); } catch { /* already gone */ }
        for (const until = Date.now() + 20_000; Date.now() < until && which.some((h) => alive(h.pid));) await new Promise((r) => setTimeout(r, 200));
        writeAll(heldRuns());
        for (const h of which) console.log(`${alive(h.pid) ? "still running" : "released"}: ${h.cell} of ${h.sweep} (pid ${h.pid})`);
        if (!which.length) console.log("no held run matches");
    } else if (!argv.length) {
        const list = heldRuns();
        if (!list.length) console.log("no runs are held open");
        for (const h of list) console.log(`${h.cell} of ${h.sweep} (pid ${h.pid}, until ${h.expiresAt} unless spoken to)\n  ${h.attach}`);
    } else {
        console.log("usage: hold.mjs [--stop [pid|cell|dir]]");
        process.exit(2);
    }
}
