#!/usr/bin/env node
// check-pins.mjs — every vendored schema and vector matches its pin, and (with --upstream) whether upstream has
// moved on since.
//
// The files under `src/proto/` and `tests/fixtures/hub/` are not ours: they live beside the Rust that produces them
// and are copied here, pinned by git BLOB ID so a copy that drifted is a fact rather than an impression. This is the
// offline half, and it is what the `tools` job runs.
//
// `--upstream` is the half that matters, and it is a POLL on purpose. A schema change upstream is invisible from
// here: our code is correct against the schema it holds and never asks for what it does not know exists. Waiting to
// be told depends on somebody remembering at exactly the moment they are busy, and the last drift hid two things —
// the whole pairing vocabulary, and a certificate rule our stale copy had backwards (it said no expiry was allowed,
// where the real rule requires both ends and caps at ninety days). The upstream repo now keeps a CHANGES.md saying
// WHAT moved; this says THAT something did, without depending on anyone.
//
// Never a failure on the upstream leg: upstream moving on is news, not a fault, and a check that fails for news is
// one people learn to skip.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const upstream = process.argv.includes("--upstream");
const pins = globSync("{src/proto/**,tests/fixtures/**}/*.pin.json").sort();
if (!pins.length) {
    console.error("check-pins: no .pin.json files found — run from the repo root");
    process.exit(2);
}

let stale = 0;
for (const pin of pins) {
    const file = pin.replace(/\.pin\.json$/, "");
    const { repo, branch, path, blob, watch } = JSON.parse(readFileSync(pin, "utf8"));
    // `branch` is where the BYTES came from and is often a tag, which never moves — so polling it can never fire.
    // `watch` is what to ask about: the branch upstream develops on. Two fields because they answer two questions,
    // and writing `main` into `branch` to make the poll work would be a lie about the provenance.
    const ref = watch || branch;
    const actual = execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim();
    if (actual === blob) {
        console.log(`ok      ${file}`);
    } else {
        stale++;
        console.log(`STALE   ${file}: blob ${actual}, pin says ${blob}`);
        console.log(`        re-vendor from ${repo}@${branch}:${path}, or update the pin if you meant to edit it`);
    }
    if (!upstream) continue;
    // `gh` may be absent or unauthenticated, and neither is this check's business to fail over.
    let head = "unknown";
    try { head = execFileSync("gh", ["api", `repos/${repo}/contents/${path}?ref=${ref}`, "--jq", ".sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { /* no gh, no network, or no such ref */ }
    if (head === "unknown") console.log(`        upstream: could not ask (is \`gh\` installed and logged in?)`);
    else if (head === blob) console.log(`        upstream ${ref} still carries it`);
    else console.log(`        upstream ${ref} HAS MOVED (blob ${head}) — read ${repo}'s proto/wmlhub/CHANGES.md`);
}
process.exit(stale ? 1 : 0);
