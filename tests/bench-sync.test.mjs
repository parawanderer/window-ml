// The bench store (tests/e2e/bench/sync.mjs, s3.mjs): what a push sends, that the pool reads back right when pushes
// overlap (the store is at-least-once), what stays on this machine, and the S3 signing. The store is an in-memory S3
// stand-in that pages its listings, so paging is exercised too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { signV4 } from "../tests/e2e/bench/s3.mjs";
import { push, pull, status, openStore, storeFromEnv, viewsSql, pushAndRecord, lastPush, lastPushLine, scheduleJob, SCHEDULE_S, isLooseRun, looseDirs, syncRecordFor, sweepRecord, syncableRuns, adopt, SYNC_FILE } from "../tests/e2e/bench/sync.mjs";
import { openScores, logRuns, readRuns } from "../tests/e2e/bench/scores.mjs";
import { openBoxLog, logFrames } from "../tests/e2e/bench/box-stream.mjs";

/** An S3 stand-in: PUT, GET, ListObjectsV2 with a page of 3 so a listing pages. Every request must be signed. */
let server, url;
const objects = new Map();
const unsigned = [], listQueries = [];
before(async () => {
    server = createServer(async (req, res) => {
        if (!/^AWS4-HMAC-SHA256 Credential=k\//.test(req.headers.authorization || "")) unsigned.push(req.url);
        const u = new URL(req.url, "http://x");
        const [, bucket, ...rest] = u.pathname.split("/");
        const key = decodeURIComponent(rest.join("/"));
        if (bucket !== "wml-bench") { res.writeHead(404); return res.end(); }
        if (req.method === "PUT") {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            objects.set(key, Buffer.concat(chunks));
            res.writeHead(200); return res.end();
        }
        if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
            listQueries.push(u.search);
            const prefix = u.searchParams.get("prefix") || "";
            const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
            const start = Number(u.searchParams.get("continuation-token") || 0);
            const page = all.slice(start, start + 3);
            const more = start + 3 < all.length;
            res.writeHead(200, { "content-type": "application/xml" });
            // Garage sends each object's ETag, the MD5 of a plain put, quoted and XML-escaped.
            const etag = (k) => `&quot;${createHash("md5").update(objects.get(k)).digest("hex")}&quot;`;
            return res.end(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${objects.get(k).length}</Size><ETag>${etag(k)}</ETag></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 3}</NextContinuationToken>` : ""}</ListBucketResult>`);
        }
        if (req.method === "GET") {
            if (!objects.has(key)) { res.writeHead(404); return res.end(); }
            res.writeHead(200); return res.end(objects.get(key));
        }
        res.writeHead(405); res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const store = () => openStore({ endpoint: url, bucket: "wml-bench", keyId: "k", secret: "s" });
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "bench-sync-"));
/** A scores row, as runRow writes one. */
const row = (run, passed, model = "m") => ({ run, at: "2026-10-09T00:00:00Z", by: "t", sweep: "s", spec: null, spec_hash: null, task: "t1", task_hash: "th", task_text: "x",
    variant: "{}", scored: 1, model, digest: null, quant: null, params: null, local: 1, vision: null, utility: null, backend: "https://b", build: "c", dirty: 0,
    passed, error: null, hit_cap: 0, prompt_tokens: 100, completion_tokens: 5, sub_tokens: 0, tokens: 105, steps: 2, secs: 1.5 });
const scoresWith = async (rows) => { const f = path.join(tmp(), "scores.sqlite"); const db = await openScores(f); logRuns(db, rows); db.close(); return f; };
const passRate = (rows) => rows.filter((r) => r.passed === 1).length / rows.length;

// --- signing ---

test("SigV4: AWS's published GET example signs to its published signature", () => {
    const { authorization } = signV4({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" },
        payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", amzDate: "20130524T000000Z", region: "us-east-1",
        keyId: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" });
    assert.equal(authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("the store is off unless all three settings are there, and the secret is read, never defaulted", () => {
    assert.equal(storeFromEnv({}, {}), null);
    assert.equal(storeFromEnv({ BENCH_STORE_URL: "https://h:3900", BENCH_STORE_KEY_ID: "k" }, {}), null);
    assert.deepEqual(storeFromEnv({ BENCH_STORE_URL: "https://h:3900" }, { BENCH_STORE_KEY_ID: "k", BENCH_STORE_SECRET: "s" }),
        { endpoint: "https://h:3900", keyId: "k", secret: "s", bucket: "wml-bench", region: "garage" });
});

// --- the logs: at-least-once, deduped on read ---

test("a push sends only what this clone has not pushed; a second push sends nothing; every request is signed", async () => {
    objects.clear();
    const scoresDb = await scoresWith([row("r1", 1), row("r2", 0)]);
    const sent = await push(store(), { clone: "a", scoresDb, boxDb: "/nonexistent", sweeps: [] });
    assert.equal(sent.scores, 2);
    assert.deepEqual((await push(store(), { clone: "a", scoresDb, boxDb: "/nonexistent", sweeps: [] })).scores, 0);
    assert.ok(objects.has("scores/a-1-2.parquet"));
    assert.ok(objects.has("views.sql"));
    assert.deepEqual(unsigned, []);
});

test("overlapping pushes from two clones and a fresh clone read back as each run once, with the single-push pass rate", async () => {
    objects.clear();
    const all = [row("r1", 1), row("r2", 0), row("r3", 1), row("r4", 1)];
    // Clone a pushed r1-r3; clone b holds r2-r4 (a copied log); a fresh checkout of a, its marker gone, pushes r1-r4 again.
    await push(store(), { clone: "a", scoresDb: await scoresWith(all.slice(0, 3)), boxDb: "/x", sweeps: [] });
    await push(store(), { clone: "b", scoresDb: await scoresWith(all.slice(1)), boxDb: "/x", sweeps: [] });
    await push(store(), { clone: "a2", scoresDb: await scoresWith(all), boxDb: "/x", sweeps: [] });
    const into = tmp();
    await pull(store(), { into });
    const db = await openScores(path.join(into, "scores.sqlite"));
    const rows = readRuns(db);
    db.close();
    assert.equal(rows.length, 4, "each run once");
    assert.equal(passRate(rows), passRate(all));
    // A second pull fetches nothing new and adds nothing.
    assert.deepEqual(await pull(store(), { into }), { scores: 0, calls: 0, snapshots: 0, box: 0, files: 0 });
});

test("box frames: pushed by range and read back once per (box, server time, kind, digest), across clones", async () => {
    objects.clear();
    const frames = [
        { frame: { kind: "sample", t: 0, ps: { models: [] } }, at: 1000, serverAt: 5000, box: "mlbox" },
        { frame: { kind: "load", t: 10, model: "m" }, at: 1010, serverAt: 5010, box: "mlbox" },
    ];
    const boxIn = async (fs) => { const f = path.join(tmp(), "box.sqlite"); const db = await openBoxLog(f); logFrames(db, fs); db.close(); return f; };
    await push(store(), { clone: "a", scoresDb: "/x", boxDb: await boxIn(frames), sweeps: [] });
    await push(store(), { clone: "b", scoresDb: "/x", boxDb: await boxIn(frames), sweeps: [] });   // the same box, watched from two clones
    const into = tmp();
    const got = await pull(store(), { into });
    assert.equal(got.box, 2);
    const db = await openBoxLog(path.join(into, "box.sqlite"));
    const back = db.prepare("SELECT kind, frame FROM frames ORDER BY server_at").all();
    db.close();
    assert.deepEqual(back.map((r) => [r.kind, JSON.parse(r.frame).kind]), [["sample", "sample"], ["load", "load"]]);
});

test("views.sql dedupes each table on its key and says to query it, not the raw objects", () => {
    const sql = viewsSql("wml-bench");
    assert.match(sql, /CREATE OR REPLACE VIEW scores AS\s+SELECT DISTINCT ON \(run\) \* FROM read_parquet\('s3:\/\/wml-bench\/scores\/\*\.parquet', union_by_name = true\)/);
    assert.match(sql, /DISTINCT ON \(box, server_at, kind, digest\)/);
    assert.match(sql, /AT-LEAST-ONCE/);
    assert.doesNotMatch(sql, /secret_access_key = '[^…]/, "no secret in a file that is uploaded");
});

test("views.sql creates a view only over a table the store holds: DuckDB fails at CREATE on a glob with no files", async () => {
    const only = viewsSql("wml-bench", ["scores"]);
    assert.match(only, /CREATE OR REPLACE VIEW scores/);
    assert.doesNotMatch(only, /VIEW box_frames/);
    assert.match(only, /-- box_frames: no box\/ objects in the store yet/);
    // As a push writes it: no rows anywhere yet, so neither view; then scores land, and only that one.
    objects.clear();
    await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [] });
    assert.doesNotMatch(String(objects.get("views.sql")), /CREATE/);
    await push(store(), { clone: "a", scoresDb: await scoresWith([row("r1", 1)]), boxDb: "/x", sweeps: [] });
    const sql = String(objects.get("views.sql"));
    assert.match(sql, /CREATE OR REPLACE VIEW scores/);
    assert.doesNotMatch(sql, /VIEW box_frames/);
});

// --- traces ---

/** A sweep directory as run.mjs leaves it: page.json, a run directory per done run with its cell.json. */
function sweepDir({ sync, runs, name = "pb" }) {
    const root = tmp(), dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sweeps.jsonl"), "{}\n");
    writeFileSync(path.join(dir, "page.json"), JSON.stringify({ runs: runs.map((r) => ({ state: "done", ...r })), ...(sync ? { sync } : {}) }));
    writeFileSync(path.join(dir, "report.md"), "# report");
    for (const r of runs) {
        mkdirSync(path.join(dir, r.path, "shots"), { recursive: true });
        writeFileSync(path.join(dir, r.path, "cell.json"), JSON.stringify({ key: `k-${r.path}`, hash: r.hash ?? null, ...(r.backend !== undefined ? { backend: r.backend } : {}) }));
        writeFileSync(path.join(dir, r.path, "run.md"), "# run");
        writeFileSync(path.join(dir, r.path, "shots", "1.png"), Buffer.from([1, 2, 3]));
    }
    return { root, dir };
}

test("a sweep's runs go under traces/<sweep>/<cell>/<run id>/, cell.json last; once there, not again; status says what is missing", async () => {
    objects.clear();
    const { root, dir } = sweepDir({ runs: [{ path: "t1/m-a/r0", taskId: "t1", hash: "h1" }, { path: "t1/m-b/r0", taskId: "t1" }] });
    const before = await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root });
    assert.deepEqual(before.sweeps[0].missing, ["t1/m-a/r0", "t1/m-b/r0"]);
    assert.equal(before.allPushed, false);
    const puts = [];
    const watched = { ...store(), put: async (k, b, t) => { puts.push(k); return store().put(k, b, t); } };
    assert.equal((await push(watched, { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [dir] })).runs, 2);
    const run = puts.filter((k) => k.startsWith("traces/pb/t1/m-a/r0/h1/"));
    assert.deepEqual(run, ["traces/pb/t1/m-a/r0/h1/run.md", "traces/pb/t1/m-a/r0/h1/shots/1.png", "traces/pb/t1/m-a/r0/h1/cell.json"].sort((a, b) => a.endsWith("cell.json") - b.endsWith("cell.json") || puts.indexOf(a) - puts.indexOf(b)));
    assert.equal(run.at(-1), "traces/pb/t1/m-a/r0/h1/cell.json", "cell.json last: a run is in the store once it is");
    assert.ok(puts.includes("traces/pb/t1/m-b/r0/key-k-t1/m-b/r0/cell.json"), "a run with no session hash goes by its cache key");
    assert.ok(puts.includes("traces/pb/_sweep/a/report.md"), "the sweep's own files, under this clone");
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [dir] })).runs, 0);
    const after = await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root });
    assert.deepEqual(after.sweeps[0].missing, []);
    assert.equal(after.allPushed, true);
    // And back down, into the pool's own directory.
    const into = tmp();
    await pull(store(), { into, traces: ["pb"] });
    assert.deepEqual([...readFileSync(path.join(into, "traces/pb/t1/m-a/r0/h1/shots/1.png"))], [1, 2, 3]);
});

test("every push sends everything pending: each sweep's missing runs, and a sweep file only when it changed (a mark added after)", async () => {
    objects.clear();
    const a = sweepDir({ runs: [{ path: "t1/m-a/r0", taskId: "t1", hash: "h1" }] });
    const b = sweepDir({ runs: [{ path: "t1/m-b/r0", taskId: "t1", hash: "h2" }], name: "pc" });
    const both = [a.dir, b.dir];
    const first = await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: both });
    assert.equal(first.runs, 2, "both sweeps' runs, from one push");
    const puts = [];
    const watched = { ...store(), put: async (k, body, t) => { puts.push(k); return store().put(k, body, t); } };
    assert.deepEqual(await push(watched, { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: both }), { scores: 0, calls: 0, snapshots: 0, box: 0, runs: 0, files: 0, loose: 0 });
    assert.deepEqual(puts.filter((k) => k.startsWith("traces/")), [], "nothing unchanged is sent again: not a run, not a report");
    writeFileSync(path.join(a.dir, "marks.jsonl"), JSON.stringify({ line: "wrong", by: "shane" }) + "\n");
    const st = await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root: a.root });
    assert.deepEqual(st.sweeps[0].changed, ["marks.jsonl"], "status names the changed file");
    assert.equal(st.allPushed, false);
    const third = await push(watched, { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: both });
    assert.equal(third.files, 1);
    assert.deepEqual(puts.filter((k) => k.startsWith("traces/")), ["traces/pb/_sweep/a/marks.jsonl"], "only the mark went");
    // The same sweep, moved into another clone (merge-when-green --keep-bench): what the first clone sent is not sent again.
    puts.length = 0;
    assert.equal((await push(watched, { clone: "main", scoresDb: "/x", boxDb: "/x", sweeps: both })).files, 0);
    assert.deepEqual(puts.filter((k) => k.startsWith("traces/")), []);
});

// --- loose runs ---

/** An artifacts directory as the other harnesses leave it: observe/converse runs, an old panel, a demo, the bench's own. */
function artifacts() {
    const root = tmp();
    const put = (rel, body = "x") => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), body); };
    put("talk-qwen/events.json", "[]"); put("talk-qwen/run.md", "# run"); put("talk-qwen/outbox/turn-1.md", "# Turn 1");
    put("panel-old-123/deepseek.deepseek-flash/run.json", "{}"); put("panel-old-123/summary.md", "# summary");
    put("table-demo/1-csv-head.png", "png");                       // screenshots only: a demo, not a run
    put("private-site/events.json", "[]"); put("private-site/.nosync", "");
    put("bench/s/sweeps.jsonl", "{}"); put("builds/abc/x.js", "js"); put("bench-pool/scores.sqlite", "db");
    return root;
}

test("a loose run is a directory holding a session's events or export, or one per model; a demo, a .nosync and the bench's own are not", async () => {
    const root = artifacts();
    assert.deepEqual((await looseDirs(root)).map((d) => path.basename(d)), ["panel-old-123", "talk-qwen"]);
    assert.equal(isLooseRun(path.join(root, "private-site")), false, ".nosync keeps it here");
});

test("every push sends the loose runs under loose/<clone>/<dir>/, each file once, a changed file again; a sweep-only push sends none", async () => {
    objects.clear();
    const root = artifacts(), loose = await looseDirs(root);
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [] })).loose, 0, "narrowed to some sweeps: no loose runs");
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [], loose })).loose, 5);
    assert.ok(objects.has("loose/a/talk-qwen/outbox/turn-1.md") && objects.has("loose/a/panel-old-123/deepseek.deepseek-flash/run.json"));
    assert.ok(![...objects.keys()].some((k) => /table-demo|private-site|builds|bench-pool/.test(k)), "nothing that is not a run, nothing marked .nosync");
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [], loose })).loose, 0, "unchanged: nothing again");
    writeFileSync(path.join(root, "talk-qwen/outbox/turn-2.md"), "# Turn 2");
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [], loose })).loose, 1, "a later turn goes alone");
    const st = await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root: path.join(root, "bench"), looseRoot: root });
    assert.deepEqual(st.loose.map((l) => [path.basename(l.dir), l.missing]), [["panel-old-123", 0], ["talk-qwen", 0]]);
});

test("each push's outcome is recorded for this clone, a failure saying what to run; the next push makes it good", async () => {
    objects.clear();
    const file = path.join(tmp(), "last-push-a.json");
    assert.equal(await lastPush(file), null);
    assert.equal(lastPushLine(null), "no push recorded yet");
    const down = { ...store(), list: async () => { throw new Error("fetch failed: connect ECONNREFUSED 100.102.255.115:3900"); } };
    const bad = await pushAndRecord(down, { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [] }, { by: "schedule", file });
    assert.equal(bad.ok, false);
    assert.deepEqual(await lastPush(file), bad);
    assert.match(lastPushLine(bad), /\(schedule\) FAILED: fetch failed: connect ECONNREFUSED .*the next push sends everything pending \(node --import tsx tests\/e2e\/bench\/sync\.mjs push\)/);
    const good = await pushAndRecord(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [] }, { by: "sweep", file });
    assert.equal(good.ok, true);
    assert.match(lastPushLine(await lastPush(file)), /\(sweep\): ok$/);
});

test("the scheduled push: a launchd job running `sync.mjs push --by schedule` from the clone every 30 minutes, logging beside the ledger", () => {
    const job = scheduleJob({ clone: "laptop-window-ml", home: "/Users/x", node: "/opt/node", root: "/Users/x/git/window-ml" });
    assert.equal(job.label, "dev.window-ml.bench-push.laptop-window-ml");
    assert.equal(job.path, "/Users/x/Library/LaunchAgents/dev.window-ml.bench-push.laptop-window-ml.plist");
    assert.match(job.plist, /<string>\/opt\/node<\/string>\s*<string>--import<\/string>\s*<string>tsx<\/string>\s*<string>\/Users\/x\/git\/window-ml\/tests\/e2e\/bench\/sync\.mjs<\/string>\s*<string>push<\/string>\s*<string>--by<\/string>\s*<string>schedule<\/string>/);
    assert.match(job.plist, new RegExp(`<key>StartInterval</key><integer>${SCHEDULE_S}</integer>`));
    assert.equal(SCHEDULE_S, 1800);
    assert.match(job.plist, /<key>WorkingDirectory<\/key><string>\/Users\/x\/git\/window-ml<\/string>/);
    assert.match(job.plist, /<key>StandardErrorPath<\/key><string>\/Users\/x\/\.cache\/window-ml-bench\/push-laptop-window-ml\.log<\/string>/);
    assert.doesNotMatch(job.plist, /SECRET|KEY_ID/, "the store's settings are read from .env at run time, never written into the job");
});

test("a run a later run of its cell replaced (history/) goes to the store too, under its cell, beside the run that replaced it", async () => {
    objects.clear();
    const { keepEarlierRun } = await import("../tests/e2e/bench/sweeps.mjs");
    const { dir } = sweepDir({ runs: [{ path: "t1/m-a/r0", taskId: "t1", hash: "old" }] });
    const kept = await keepEarlierRun(dir, "t1/m-a/r0");
    // The cell ran again: a new run in its place.
    mkdirSync(path.join(dir, "t1/m-a/r0"), { recursive: true });
    writeFileSync(path.join(dir, "t1/m-a/r0", "cell.json"), JSON.stringify({ key: "k2", hash: "new" }));
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [dir] })).runs, 2);
    assert.ok(objects.has("traces/pb/t1/m-a/r0/new/cell.json"));
    assert.ok(objects.has("traces/pb/t1/m-a/r0/old/cell.json"), `the replaced run, from ${kept}`);
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [dir] })).runs, 0, "and not again");
});

test("a run against the fake LLM never reaches the store, whatever the flags; a sweep of nothing else sends not even its report", async () => {
    objects.clear();
    const mixed = sweepDir({ runs: [
        { path: "t1/m-real/r0", taskId: "t1", hash: "real", backend: "https://box/api/chat/completions (model m)" },
        { path: "t1/m-fake/r0", taskId: "t1", hash: "fake", backend: "fake-LLM" },
        { path: "t1/m-old/r0", taskId: "t1", hash: "old" },   // saved before `backend` was: unknown, not fake
    ] });
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [mixed.dir] })).runs, 2);
    assert.ok(objects.has("traces/pb/t1/m-real/r0/real/cell.json"));
    assert.ok(objects.has("traces/pb/t1/m-old/r0/old/cell.json"));
    assert.ok(![...objects.keys()].some((k) => k.includes("/m-fake/")), "the fake's run stays here");
    const st = await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root: mixed.root });
    assert.deepEqual(st.sweeps[0].missing, [], "and status does not count it as missing");
    objects.clear();
    const fake = sweepDir({ runs: [{ path: "t1/m/r0", taskId: "t1", hash: "f", backend: "fake-LLM" }] });
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [fake.dir] })).runs, 0);
    assert.deepEqual([...objects.keys()].filter((k) => k.startsWith("traces/")), [], "no runs, so no page.json or report either");
});

test("what stays here: a sweep whose spec said sync: false, a task that did, and every run with --only-db", async () => {
    objects.clear();
    const off = sweepDir({ sync: { off: true, tasksOff: [] }, runs: [{ path: "t1/x/r0", taskId: "t1", hash: "h" }] });
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [off.dir] })).runs, 0);
    assert.equal([...objects.keys()].filter((k) => k.startsWith("traces/")).length, 0, "not even its report");
    const some = sweepDir({ sync: { off: false, tasksOff: ["private"] }, runs: [{ path: "private/x/r0", taskId: "private", hash: "p" }, { path: "pub/x/r0", taskId: "pub", hash: "q" }] });
    await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [some.dir] });
    assert.ok([...objects.keys()].some((k) => k.startsWith("traces/pb/pub/")));
    assert.ok(![...objects.keys()].some((k) => k.startsWith("traces/pb/private/")));
    objects.clear();
    const plain = sweepDir({ runs: [{ path: "t1/x/r0", taskId: "t1", hash: "h" }] });
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [plain.dir], onlyDb: true })).runs, 0);
    assert.ok(![...objects.keys()].some((k) => k.startsWith("traces/")));
});

// --- a sweep that never finished: sync.json, written at its start ---

/** A sweep stopped before its end: cells on disk, no page.json, and sync.json only when `sync` is given. */
function unfinishedSweep({ sync, cells, name = "uf" }) {
    const root = tmp(), dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sweeps.jsonl"), "{}\n");
    if (sync) writeFileSync(path.join(dir, SYNC_FILE), JSON.stringify(sync));
    for (const c of cells) {
        mkdirSync(path.join(dir, c.path), { recursive: true });
        writeFileSync(path.join(dir, c.path, "run.md"), "# run");
        if (!c.running) writeFileSync(path.join(dir, c.path, "cell.json"), JSON.stringify({ key: `k-${c.path}`, taskId: c.path.split("/")[0], hash: c.hash ?? null, ...(c.backend ? { backend: c.backend } : {}) }));
    }
    return { root, dir };
}

test("what a sweep may send is recorded at its start: off for sync: false, --no-sync, --only-db; a task's own; nothing else", () => {
    const spec = (sync, taskSync) => ({ ...(sync === undefined ? {} : { sync }), tasks: [{ id: "a" }, { id: "b", ...(taskSync === undefined ? {} : { sync: taskSync }) }] });
    assert.deepEqual(syncRecordFor(spec(), {}), { off: false, tasksOff: [] }, "the default sends everything");
    assert.deepEqual(syncRecordFor(spec(false), {}), { off: true, tasksOff: [], by: "spec" });
    assert.deepEqual(syncRecordFor(spec(), { sync: false }), { off: true, tasksOff: [], by: "--no-sync" });
    assert.deepEqual(syncRecordFor(spec(), { onlyDb: true }), { off: true, tasksOff: [], by: "--only-db" });
    assert.deepEqual(syncRecordFor(spec(undefined, false), {}), { off: false, tasksOff: ["b"] });
    assert.deepEqual(syncRecordFor(spec(true, true), {}), { off: false, tasksOff: [] }, "sync: true says nothing more than the default");
});

test("an unfinished sweep sends its finished cells by its sync.json: not one still running, a task that is off, or the fake's", async () => {
    objects.clear();
    const { dir } = unfinishedSweep({ sync: { off: false, tasksOff: ["t2"] }, cells: [
        { path: "t1/m-a/r0", hash: "h1" }, { path: "t1/m-b/r0", running: true }, { path: "t2/m-a/r0", hash: "h2" }, { path: "t3/m-a/r0", hash: "h3", backend: "fake-LLM" },
    ] });
    assert.deepEqual((await syncableRuns(dir)).map((r) => r.prefix), ["traces/uf/t1/m-a/r0/h1/"]);
    const puts = [];
    const watched = { ...store(), put: async (k, b, t) => { puts.push(k); return store().put(k, b, t); } };
    assert.equal((await push(watched, { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [dir] })).runs, 1);
    assert.ok(puts.includes(`traces/uf/_sweep/a/${SYNC_FILE}`), "its record goes with it");
    // Then it finishes (or is re-run) with --no-sync: off, though the page.json it ends with is the one that said nothing.
    writeFileSync(path.join(dir, SYNC_FILE), JSON.stringify({ off: true, tasksOff: [], by: "--no-sync" }));
    writeFileSync(path.join(dir, "page.json"), JSON.stringify({ runs: [{ state: "done", path: "t1/m-a/r0", taskId: "t1" }] }));
    assert.deepEqual(await syncableRuns(dir), [], "off when either record says so");
});

test("a sweep from before sync.json that never finished sends nothing until adopted; status names it and is not all pushed", async () => {
    objects.clear();
    const { root, dir } = unfinishedSweep({ cells: [{ path: "t1/m-a/r0", hash: "h1" }, { path: "t1/m-b/r0", hash: "h2" }] });
    assert.equal((await sweepRecord(dir)).rule, null);
    assert.deepEqual(await syncableRuns(dir), []);
    const st = await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root });
    assert.equal(st.sweeps[0].unrecorded, 2, "its finished cells, which no push sends");
    assert.equal(st.allPushed, false, "merge-when-green must not take its runs for pushed");
    await adopt(dir);
    await assert.rejects(adopt(dir), /already says/, "adopted once");
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, SYNC_FILE), "utf8")), { off: false, tasksOff: [], by: "adopt" });
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [dir] })).runs, 2);
    assert.equal((await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root })).allPushed, true);
    // Adopted as off: nothing goes, and nothing is pending.
    objects.clear();
    const off = unfinishedSweep({ cells: [{ path: "t1/m-a/r0", hash: "h1" }], name: "uf2" });
    await adopt(off.dir, { off: true });
    assert.equal((await push(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", sweeps: [off.dir] })).runs, 0);
    assert.equal((await status(store(), { clone: "a", scoresDb: "/x", boxDb: "/x", root: off.root })).allPushed, true);
    await assert.rejects(adopt(tmp()), /not a sweep directory/);
});

test("a listing of the whole bucket sends no empty prefix: Garage refuses `prefix=` as an invalid signature", async () => {
    listQueries.length = 0;
    await store().list("");
    await store().list("scores/");
    assert.doesNotMatch(listQueries[0], /prefix=/);
    assert.match(listQueries[1], /prefix=scores%2F/);
});

test("not configured: status says so and nothing else", async () => {
    assert.deepEqual(await status(null), { configured: false });
    assert.ok(!existsSync("/nonexistent"));
});

// --- the spend tables ---

test("calls and price snapshots go through the store and back once each, a snapshot's bytes exact", async () => {
    objects.clear();
    const { callsOf, logCalls, logSnapshot, readCalls } = await import("../tests/e2e/bench/spend.mjs");
    const { createHash } = await import("node:crypto");
    const session = JSON.parse(readFileSync(new URL("./fixtures/bench/spend-session.json", import.meta.url)));
    const body = Buffer.from([0, 255, 10, 13, 0xe2, 0x82]);   // not valid UTF-8: only base64 brings it back whole
    const hash = createHash("sha256").update(body).digest("hex");
    const logWith = async () => {
        const f = path.join(tmp(), "scores.sqlite"); const db = await openScores(f);
        logCalls(db, callsOf(session)); logSnapshot(db, { hash, kind: "openrouter", body }); db.close(); return f;
    };
    const sent = await push(store(), { clone: "a", scoresDb: await logWith(), boxDb: "/x", sweeps: [] });
    assert.deepEqual([sent.calls, sent.snapshots], [3, 1]);
    await push(store(), { clone: "b", scoresDb: await logWith(), boxDb: "/x", sweeps: [] });
    const into = tmp();
    const got = await pull(store(), { into });
    assert.deepEqual([got.calls, got.snapshots], [3, 1]);
    const db = await openScores(path.join(into, "scores.sqlite"));
    assert.equal(readCalls(db).length, 3);
    assert.deepEqual(Buffer.from(db.prepare("SELECT body FROM snapshots").get().body), body);
    db.close();
    assert.match(String(objects.get("views.sql")), /CREATE OR REPLACE VIEW calls AS[\s\S]*DISTINCT ON \(run, call\)/);
});
