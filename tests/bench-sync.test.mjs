// The bench store (tests/e2e/bench/sync.mjs, s3.mjs): what a push sends, that the pool reads back right when pushes
// overlap (the store is at-least-once), what stays on this machine, and the S3 signing. The store is an in-memory S3
// stand-in that pages its listings, so paging is exercised too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { signV4 } from "../tests/e2e/bench/s3.mjs";
import { push, pull, status, openStore, storeFromEnv, viewsSql } from "../tests/e2e/bench/sync.mjs";
import { openScores, logRuns, readRuns } from "../tests/e2e/bench/scores.mjs";
import { openBoxLog, logFrames } from "../tests/e2e/bench/box-stream.mjs";

/** An S3 stand-in: PUT, GET, ListObjectsV2 with a page of 3 so a listing pages. Every request must be signed. */
let server, url;
const objects = new Map();
const unsigned = [];
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
            const prefix = u.searchParams.get("prefix") || "";
            const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
            const start = Number(u.searchParams.get("continuation-token") || 0);
            const page = all.slice(start, start + 3);
            const more = start + 3 < all.length;
            res.writeHead(200, { "content-type": "application/xml" });
            return res.end(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${objects.get(k).length}</Size></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 3}</NextContinuationToken>` : ""}</ListBucketResult>`);
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
    assert.deepEqual(await pull(store(), { into }), { scores: 0, box: 0, files: 0 });
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
function sweepDir({ sync, runs }) {
    const root = tmp(), dir = path.join(root, "pb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sweeps.jsonl"), "{}\n");
    writeFileSync(path.join(dir, "page.json"), JSON.stringify({ runs: runs.map((r) => ({ state: "done", ...r })), ...(sync ? { sync } : {}) }));
    writeFileSync(path.join(dir, "report.md"), "# report");
    for (const r of runs) {
        mkdirSync(path.join(dir, r.path, "shots"), { recursive: true });
        writeFileSync(path.join(dir, r.path, "cell.json"), JSON.stringify({ key: `k-${r.path}`, hash: r.hash ?? null }));
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

test("not configured: status says so and nothing else", async () => {
    assert.deepEqual(await status(null), { configured: false });
    assert.ok(!existsSync("/nonexistent"));
});
