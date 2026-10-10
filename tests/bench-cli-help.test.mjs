// The bench's CLI docs (tests/e2e/bench/cli-help.mjs): `--help` on run.mjs and hold.mjs prints each script's header, and
// every flag either script parses is in its help and in the bench skill's docs, read from the source rather than listed
// here, so a new flag without docs fails; an unknown flag or a bad `--when-full` is an error naming what it takes; and
// what `--when-full release-duplicates` releases: one sweep's own duplicates, one of each kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { headerHelp, parsedFlags } from "../tests/e2e/bench/cli-help.mjs";
import { duplicatesToRelease, groupCommands, groupHeld } from "../tests/e2e/bench/hold-menu.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => readFileSync(path.join(ROOT, f), "utf8");
const url = (f) => new URL(`../${f}`, import.meta.url).href;
const SKILL = src(".claude/skills/bench/SKILL.md");
const FLAGS_TABLE = SKILL.slice(SKILL.indexOf("## Flags"), SKILL.indexOf("## What it writes"));
const node = (f, ...a) => execFileSync(process.execPath, ["--import", "tsx", f, ...a], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// --- every flag is documented ---

test("every flag run.mjs parses is in its --help and in the skill's Flags table", () => {
    const flags = parsedFlags(src("tests/e2e/bench/run.mjs"));
    assert.ok(flags.length >= 25 && flags.includes("--when-full") && flags.includes("--help"), `read from the source: ${flags}`);
    const help = headerHelp(url("tests/e2e/bench/run.mjs"));
    for (const f of flags) {
        assert.match(help, new RegExp(`${f}\\b`), `${f} missing from run.mjs --help`);
        assert.match(FLAGS_TABLE, new RegExp(`\`${f}\\b`), `${f} missing from the skill's Flags table`);
    }
});

test("every flag hold.mjs takes is in its --help and in the skill, but the internal --child", () => {
    const flags = parsedFlags(src("tests/e2e/bench/hold.mjs")).filter((f) => f !== "--child");
    assert.deepEqual(flags, ["--help", "--hide", "--ledger", "--limit", "--menu", "--show", "--stop"]);
    const help = headerHelp(url("tests/e2e/bench/hold.mjs"));
    for (const f of flags) {
        assert.match(help, new RegExp(`${f}\\b`), `${f} missing from hold.mjs --help`);
        assert.match(FLAGS_TABLE, new RegExp(`\`${f}\\b`), `${f} missing from the skill's hold.mjs line`);
    }
});

test("the flag reader finds both shapes of comparison, and nothing that is not one", () => {
    assert.deepEqual(parsedFlags(`if (a === "--x") 1; else if (argv[0] === "--y-z") 2; const s = "--not-a-flag";`), ["--x", "--y-z"]);
});

// --- at the terminal ---

test("--help prints the script's header and exits 0, for both", () => {
    const run = node("tests/e2e/bench/run.mjs", "--help");
    assert.match(run, /^run\.mjs — walk a bench spec's matrix and report it\./);
    assert.match(run, /--when-full pause \| stop-holding \| release-duplicates/);
    assert.ok(!run.includes("// "), "the comment marks are gone");
    assert.match(node("tests/e2e/bench/hold.mjs", "--help"), /^hold\.mjs — keep a bench cell's run open/);
});

test("an unknown flag, or --when-full given something else, is an error naming what it takes (a typo never runs the default)", () => {
    const fails = (...a) => { try { node("tests/e2e/bench/run.mjs", ...a); return null; } catch (e) { return [e.status, String(e.stderr)]; } };
    const [code, err] = fails("tests/e2e/bench/specs/smoke.bench.ts", "--when-ful", "stop-holding");
    assert.equal(code, 2);
    assert.match(err, /unknown flag --when-ful \(--help lists them\)/);
    assert.match(fails("tests/e2e/bench/specs/smoke.bench.ts", "--when-full", "release")[1], /--when-full takes pause, stop-holding, release-duplicates, not release/);
});

// --- what release-duplicates releases ---

const held = (pid, model, task, failure, sweep = "cuts2", repo = "/r") => ({ kind: "held", pid, model, task, failure, rss: 1e9, sweep, repo, cell: `${task}/${model}/r${pid}`, dir: `d/${pid}` });

test("release-duplicates releases one sweep's own duplicates, keeping the run each group's attach line names; never another sweep's or clone's", () => {
    const glm = [held(101, "glm", "icon-heart", "step cap"), held(102, "glm", "icon-heart", "step cap"), held(103, "glm", "icon-heart", "step cap")];
    const entries = [...glm, held(201, "qwen", "csv", "wrong answer"),
        held(301, "glm", "icon-heart", "step cap", "other-sweep"), held(302, "glm", "icon-heart", "step cap", "other-sweep"),
        held(401, "glm", "icon-heart", "step cap", "cuts2", "/another-clone"), { kind: "running", pid: 9, sweep: "cuts2", repo: "/r" }];
    const go = duplicatesToRelease(entries, { sweep: "cuts2", repo: "/r" });
    assert.deepEqual(go.map((r) => [r.pid, r.key]), [[102, "glm · icon-heart · step cap"], [103, "glm · icon-heart · step cap"]]);
    assert.match(groupCommands(groupHeld(glm)[0]).attach, /d\/101/, "the kept one is the one attach names");
    assert.deepEqual(duplicatesToRelease([held(1, "a", "t", "x"), held(2, "b", "t", "x")], { sweep: "cuts2", repo: "/r" }), [], "no duplicates, nothing");
});
