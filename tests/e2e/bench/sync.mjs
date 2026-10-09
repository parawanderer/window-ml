// sync.mjs — the bench's data, pooled in one store for analysis off the laptop: every clone's scoreboard rows and box
// frames as Parquet, and each sweep's run directories (traces), in an S3 bucket (Garage on mlbox: mlbox
// reports/ui-api/bench-data-store-answer.md). Opt-in: nothing happens unless the store is configured in .env.
//
//   node --import tsx tests/e2e/bench/sync.mjs push [--only-db] [--sweep <dir>]   send what the store does not have
//   node --import tsx tests/e2e/bench/sync.mjs pull [--traces <sweep>]...         fetch it into artifacts/bench-pool/
//   node --import tsx tests/e2e/bench/sync.mjs status [--json]                    what is here and not there
//
// THE STORE IS AT-LEAST-ONCE. A push sends the rows past the last one this clone already pushed (by the store's own
// listing), named by their range, so an identical re-push replaces an object; but two pushes that OVERLAP without being
// identical (a fresh clone, a log restored from elsewhere, two clones holding the same box frames) both land. Readers
// dedupe on the key: `pull` loads into SQLite under the same UNIQUE keys the logs have, and DuckDB on the box reads the
// views in views.sql (DISTINCT ON the key), never the raw globs.
//
// WHAT A TRACE HOLDS: screenshots, DOM snapshots and page text from whatever site the run was on, logged-in pages
// included. A spec or task with `sync: false` keeps its runs' directories here; `--only-db` sends rows only.
//
// THE STORE AND ANY PULLED COPIES ARE THE ONLY COPIES of what was pushed: nothing backs the pool up off the box (a
// nightly copy goes to /srv/hdd, another disk on the same machine). That copy's disk is NTFS mounted with no umask, so it
// is readable by any local user on the box: private on a single-user box in practice, not by permission (an fstab fix is
// on Shane's list). The store itself is tailnet-only, one key, and refuses anonymous reads.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { s3Client } from "./s3.mjs";
import { readDotenv } from "../../../scripts/dotenv.mjs";
import { openScores, COLS as SCORE_COLS, logRuns, SCORES_DB } from "./scores.mjs";
import { openBoxLog, BOX_DB } from "./box-stream.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
/** Where sweeps are written. */
export const ARTROOT = path.join(ROOT, "tests/e2e/artifacts/bench");
/** Where `pull` puts what it fetches: never mixed with the sweeps this clone ran. */
export const POOL = path.join(ROOT, "tests/e2e/artifacts/bench-pool");

/** Rows per Parquet object: a sweep's worth is a few hundred, a box log's a few hundred thousand frames. */
const BATCH = 50_000;

/**
 * The store's settings, or null when it is not configured (the default: nothing is pushed). From the environment or
 * .env: BENCH_STORE_URL (`https://host:3900`), BENCH_STORE_KEY_ID, BENCH_STORE_SECRET, and optionally
 * BENCH_STORE_BUCKET (`wml-bench`) and BENCH_STORE_REGION (`garage`). The secret is never printed or written anywhere.
 */
export function storeFromEnv(env = process.env, dotenv = null) {
    let dot = dotenv;
    if (!dot) { try { dot = readDotenv(); } catch { dot = {}; } }
    const get = (k) => env[k] || dot[k] || "";
    const endpoint = get("BENCH_STORE_URL"), keyId = get("BENCH_STORE_KEY_ID"), secret = get("BENCH_STORE_SECRET");
    if (!endpoint || !keyId || !secret) return null;
    return { endpoint, keyId, secret, bucket: get("BENCH_STORE_BUCKET") || "wml-bench", region: get("BENCH_STORE_REGION") || "garage" };
}

/** This clone's name in the store's object names: BENCH_CLONE, else `<host>-<checkout dir>`. Stable per checkout. */
export const cloneName = (env = process.env) => env.BENCH_CLONE || `${os.hostname().split(".")[0]}-${path.basename(ROOT)}`.replace(/[^\w.-]+/g, "-");

// --- the two logs, as Parquet ---

/** The scoreboard's runs, column by column: integers as INT32, seconds as DOUBLE, the rest as text. */
const SCORE_TYPES = Object.fromEntries(SCORE_COLS.map((c) => [c,
    ["scored", "local", "dirty", "passed", "hit_cap", "prompt_tokens", "completion_tokens", "sub_tokens", "tokens", "steps"].includes(c) ? "INT32"
        : c === "secs" ? "DOUBLE" : "STRING"]));
/** The box log's frames: typed keys, and the frame itself as its JSON text (frames are nested and follow the fork's
 *  events.proto, so flattening them would break on its next change). Times are milliseconds, as DOUBLE. */
const BOX_TYPES = { box: "STRING", server_at: "DOUBLE", at: "DOUBLE", kind: "STRING", frame: "STRING", digest: "STRING" };

/** The tables the store holds, each with where its rows come from and its dedupe key. */
const TABLES = {
    scores: { types: SCORE_TYPES, key: ["run"], open: (file) => openScores(file), select: "SELECT id, " + SCORE_COLS.join(", ") + " FROM runs WHERE id > ? ORDER BY id" },
    box: { types: BOX_TYPES, key: ["box", "server_at", "kind", "digest"], open: (file) => openBoxLog(file), select: "SELECT id, box, server_at, at, kind, frame, digest FROM frames WHERE id > ? ORDER BY id" },
};

const toParquet = (rows, types) => Buffer.from(parquetWriteBuffer({
    columnData: Object.entries(types).map(([name, type]) => ({ name, type, data: rows.map((r) => (r[name] == null ? null : type === "STRING" ? String(r[name]) : Number(r[name]))) })),
}));

/** The last local row id this clone has pushed to `table`, from the store's own names (`<table>/<clone>-<from>-<to>.parquet`). */
async function pushedThrough(store, table, clone) {
    let last = 0;
    for (const o of await store.list(`${table}/${clone}-`)) {
        const m = /-(\d+)-(\d+)\.parquet$/.exec(o.key);
        if (m) last = Math.max(last, Number(m[2]));
    }
    return last;
}

/** Send `table`'s rows past what this clone already pushed, in BATCH-sized objects. Resolves how many rows went. */
async function pushTable(store, table, db, clone) {
    const t = TABLES[table];
    let from = await pushedThrough(store, table, clone), sent = 0;
    for (;;) {
        const rows = db.prepare(t.select + ` LIMIT ${BATCH}`).all(from);
        if (!rows.length) return sent;
        const first = rows[0].id, last = rows.at(-1).id;
        await store.put(`${table}/${clone}-${first}-${last}.parquet`, toParquet(rows, t.types), "application/vnd.apache.parquet");
        sent += rows.length;
        from = last;
    }
}

/**
 * DuckDB views over the pool, deduped on each table's key: what an analysis reads instead of the raw objects. Only for
 * the tables in `present`: DuckDB resolves a view's glob when the view is CREATED, so a view over a prefix with no
 * objects yet fails there, and a script run as one batch stops at it. An absent table gets a comment saying so.
 */
export function viewsSql(bucket, present = Object.keys(TABLES)) {
    const view = (name, table) => {
        if (!present.includes(table)) return `-- ${name}: no ${table}/ objects in the store yet; the next push after there are writes this view.`;
        const key = TABLES[table].key.join(", ");
        return `CREATE OR REPLACE VIEW ${name} AS\n    SELECT DISTINCT ON (${key}) * FROM read_parquet('s3://${bucket}/${table}/*.parquet', union_by_name = true);`;
    };
    return `-- The bench pool's tables, one row per key. The store is AT-LEAST-ONCE: overlapping pushes put a row in several
-- objects, so query these views, never read_parquet over the objects directly.
--
-- SET s3_endpoint = '<host>:3900'; SET s3_url_style = 'path'; SET s3_region = 'garage'; SET s3_use_ssl = true;
-- SET s3_access_key_id = '…'; SET s3_secret_access_key = '…';   -- from the store's key, never committed
${view("scores", "scores")}
${view("box_frames", "box")}
`;
}

// --- traces ---

/** The sweep directories under `root` (each has a sweeps.jsonl), newest first. */
async function sweepDirs(root = ARTROOT) {
    const out = [];
    for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (d.isDirectory() && existsSync(path.join(root, d.name, "sweeps.jsonl"))) out.push(path.join(root, d.name));
    }
    return out;
}

/** Every file under `dir`, as paths relative to it. */
async function filesUnder(dir, rel = "") {
    const out = [];
    for (const d of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) out.push(...await filesUnder(dir, r));
        else if (d.isFile()) out.push(r);
    }
    return out;
}

/**
 * The runs of a sweep that may leave this machine, each with the store prefix it lives under:
 * `traces/<sweep>/<cell path>/<run id>/`, the run id being its session hash (or its cache key, for a run that errored
 * before it had one), so a re-run lands beside the old one. None when the spec said `sync: false`; a task that said so
 * keeps its runs here.
 */
export async function syncableRuns(sweepDir) {
    let page;
    try { page = JSON.parse(await readFile(path.join(sweepDir, "page.json"), "utf8")); } catch { return []; }   // in flight, or before page.json
    if (page.sync?.off) return [];
    const tasksOff = new Set(page.sync?.tasksOff ?? []);
    const sweep = path.basename(sweepDir);
    const out = [];
    for (const r of page.runs ?? []) {
        if (r.state !== "done" || !r.path || tasksOff.has(r.taskId)) continue;
        let cell;
        try { cell = JSON.parse(await readFile(path.join(sweepDir, r.path, "cell.json"), "utf8")); } catch { continue; }
        const id = cell.hash ?? `key-${cell.key}`;
        out.push({ dir: path.join(sweepDir, r.path), prefix: `traces/${sweep}/${r.path}/${id}/` });
    }
    return out;
}

/** The runs of a sweep the store has not got (a run is there once its cell.json is: it goes last). */
async function missingRuns(store, sweepDir) {
    const runs = await syncableRuns(sweepDir);
    if (!runs.length) return [];
    const have = new Set((await store.list(`traces/${path.basename(sweepDir)}/`)).map((o) => o.key));
    return runs.filter((r) => !have.has(`${r.prefix}cell.json`));
}

/** Send a sweep's missing runs, cell.json last in each, then its sweep-level files (page.json, report, marks…) under this clone. */
async function pushSweep(store, sweepDir, clone) {
    const missing = await missingRuns(store, sweepDir);
    for (const run of missing) {
        const files = (await filesUnder(run.dir)).sort((a, b) => (a === "cell.json") - (b === "cell.json"));
        for (const f of files) await store.put(`${run.prefix}${f}`, await readFile(path.join(run.dir, f)));
    }
    let page = null;
    try { page = JSON.parse(await readFile(path.join(sweepDir, "page.json"), "utf8")); } catch { /* nothing to describe it */ }
    if (page && !page.sync?.off) {
        for (const d of await readdir(sweepDir, { withFileTypes: true })) {
            if (d.isFile()) await store.put(`traces/${path.basename(sweepDir)}/_sweep/${clone}/${d.name}`, await readFile(path.join(sweepDir, d.name)));
        }
    }
    return missing.length;
}

// --- the commands ---

/**
 * Send what the store does not have: both logs' new rows, views.sql, and (unless `onlyDb`) the runs of `sweeps` (every
 * sweep under artifacts/bench by default). Resolves what was sent.
 */
export async function push(store, { clone = cloneName(), sweeps = null, onlyDb = false, scoresDb = SCORES_DB, boxDb = BOX_DB, log = () => {} } = {}) {
    const sent = { scores: 0, box: 0, runs: 0 };
    for (const [table, file] of [["scores", scoresDb], ["box", boxDb]]) {
        if (!existsSync(file)) continue;
        const db = await TABLES[table].open(file);
        if (!db) continue;
        try { sent[table] = await pushTable(store, table, db, clone); } finally { db.close(); }
    }
    // Views for the tables the store holds now (any clone's), after this push's rows have landed.
    const present = [];
    for (const table of Object.keys(TABLES)) if ((await store.list(`${table}/`)).some((o) => o.key.endsWith(".parquet"))) present.push(table);
    await store.put("views.sql", viewsSql(store.bucket ?? "wml-bench", present), "text/plain; charset=utf-8");
    if (!onlyDb) for (const dir of sweeps ?? await sweepDirs()) sent.runs += await pushSweep(store, dir, clone);
    log(`  store: ${sent.scores} score row(s), ${sent.box} box frame(s), ${sent.runs} run(s) sent`);
    return sent;
}

/**
 * Fetch the pool into `into` (artifacts/bench-pool by default): every clone's rows into scores.sqlite and box.sqlite
 * there, under the logs' own UNIQUE keys, so a row pushed twice is one row; an object already fetched is skipped. With
 * `traces`, those sweeps' run directories too, into `into/traces/<sweep>/`.
 */
export async function pull(store, { into = POOL, traces = [], log = () => {} } = {}) {
    await mkdir(into, { recursive: true });
    const got = { scores: 0, box: 0, files: 0 };
    for (const [table, file] of [["scores", path.join(into, "scores.sqlite")], ["box", path.join(into, "box.sqlite")]]) {
        const db = await TABLES[table].open(file);
        if (!db) throw new Error("this Node has no node:sqlite");
        try {
            db.exec("CREATE TABLE IF NOT EXISTS pulled (object TEXT PRIMARY KEY)");
            const seen = db.prepare("SELECT 1 FROM pulled WHERE object = ?");
            for (const o of await store.list(`${table}/`)) {
                if (!o.key.endsWith(".parquet") || seen.get(o.key)) continue;
                const buf = await store.get(o.key);
                if (!buf) continue;
                const rows = await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
                got[table] += table === "scores" ? logRuns(db, rows) : insertFrames(db, rows);
                db.prepare("INSERT OR IGNORE INTO pulled (object) VALUES (?)").run(o.key);
            }
        } finally { db.close(); }
    }
    for (const sweep of traces) {
        for (const o of await store.list(`traces/${sweep}/`)) {
            const dest = path.join(into, o.key);
            if (existsSync(dest) && (await stat(dest)).size === o.size) continue;
            const buf = await store.get(o.key);
            if (!buf) continue;
            await mkdir(path.dirname(dest), { recursive: true });
            await writeFile(dest, buf);
            got.files++;
        }
    }
    log(`  pool: ${got.scores} new score row(s), ${got.box} new box frame(s), ${got.files} trace file(s) into ${path.relative(ROOT, into)}`);
    return got;
}

/** Box frames as they came out of Parquet, into a box log; one already there (its key) is skipped. */
function insertFrames(db, rows) {
    const ins = db.prepare("INSERT OR IGNORE INTO frames (box, server_at, at, kind, frame, digest) VALUES (?, ?, ?, ?, ?, ?)");
    let added = 0;
    for (const r of rows) added += Number(ins.run(r.box, r.server_at ?? null, r.at, r.kind, r.frame, r.digest).changes);
    return added;
}

/**
 * What this clone holds that the store has not got: rows past what it pushed, per log, and runs per sweep. `configured`
 * false (and nothing else) when there is no store. For merge-when-green, which keeps a worktree whose runs are only here.
 */
export async function status(store, { clone = cloneName(), scoresDb = SCORES_DB, boxDb = BOX_DB, root = ARTROOT } = {}) {
    if (!store) return { configured: false };
    const out = { configured: true, clone, logs: {}, sweeps: [] };
    for (const [table, file] of [["scores", scoresDb], ["box", boxDb]]) {
        const db = existsSync(file) ? await TABLES[table].open(file) : null;
        const local = db ? Number(db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table === "scores" ? "runs" : "frames"}`).get().n) : 0;
        db?.close();
        const pushed = await pushedThrough(store, table, clone);
        out.logs[table] = { localThrough: local, pushedThrough: pushed, unpushed: Math.max(0, local - pushed) };
    }
    for (const dir of await sweepDirs(root)) {
        const missing = await missingRuns(store, dir);
        out.sweeps.push({ dir: path.relative(ROOT, dir), runs: (await syncableRuns(dir)).length, missing: missing.map((m) => path.relative(dir, m.dir)) });
    }
    out.allPushed = Object.values(out.logs).every((l) => l.unpushed === 0) && out.sweeps.every((s) => !s.missing.length);
    return out;
}

/** A store client from settings (s3.mjs), carrying its bucket name for views.sql. */
export const openStore = (cfg) => ({ ...s3Client(cfg), bucket: cfg.bucket });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [cmd, ...rest] = process.argv.slice(2);
    const cfg = storeFromEnv();
    const flag = (f) => rest.includes(f);
    const values = (f) => rest.flatMap((a, i) => (a === f && rest[i + 1] ? [rest[i + 1]] : []));
    if (cmd === "status") {
        const s = await status(cfg && openStore(cfg));
        if (flag("--json")) console.log(JSON.stringify(s, null, 2));
        else if (!s.configured) console.log("the bench store is not configured (BENCH_STORE_URL, BENCH_STORE_KEY_ID, BENCH_STORE_SECRET in .env)");
        else {
            for (const [t, l] of Object.entries(s.logs)) console.log(`  ${t}: ${l.unpushed} row(s) not in the store`);
            for (const sw of s.sweeps) console.log(`  ${sw.dir}: ${sw.missing.length} of ${sw.runs} run(s) not in the store`);
        }
    } else if (cmd === "push" || cmd === "pull") {
        if (!cfg) { console.error("the bench store is not configured (BENCH_STORE_URL, BENCH_STORE_KEY_ID, BENCH_STORE_SECRET in .env)"); process.exit(2); }
        const store = openStore(cfg);
        if (cmd === "push") await push(store, { onlyDb: flag("--only-db"), sweeps: values("--sweep").length ? values("--sweep").map((d) => path.resolve(d)) : null, log: console.log });
        else await pull(store, { traces: values("--traces"), log: console.log });
    } else {
        console.log("usage: sync.mjs push [--only-db] [--sweep <dir>] | pull [--traces <sweep>] | status [--json]");
        process.exit(2);
    }
}
