// hold-menu.mjs — what to do with the runs the bench holds open: grouped by model, task and how each failed, so six of
// the same failure read as one line ("6 × glm-4.7-flash · icon-heart · step cap"), each group with a command to paste
// for every action (attach, keep one and release the rest, release the group, release one, resume the sweep). Printed
// when a sweep ends with runs held or stops at the memory budget, by `hold.mjs --menu` at any time, and on the page.
// Every command starts with `cd <clone>`, so it works pasted into any terminal, by a person as well as an agent, and is
// written for the shell of the machine it was made on (PowerShell on Windows).

import { fmtBytes } from "./memory-budget.mjs";

/** What to do with them, in the order to consider it (Shane's). */
export const HOLD_HINTS = [
    "The same model failing the same way: keep one, release the duplicates.",
    "Do what you held them for now (for example, have a Sonnet subagent debrief them), then release them.",
    "Or whatever else the task needs.",
];

/** How a run failed, in a few words, for grouping: "step cap", "rate-limited", "timed out", "wrong answer", "error: …", or "ok". */
export function failureShape(m) {
    if (!m) return "unknown";
    if (m.hitCap) return "step cap";
    if (!m.ok) {
        const e = String(m.error ?? "");
        if (/rate.?limit|429/i.test(e)) return "rate-limited";
        if (/timed? ?out|timeout/i.test(e)) return "timed out";
        return `error: ${e.replace(/\s+/g, " ").replace(/\b[0-9a-f]{8,}\b/gi, "…").slice(0, 48) || "?"}`;
    }
    if (m.succeeded === false) return "wrong answer";
    return "ok";
}

/** A word list as a command line for the shell of `platform` (the machine the bench runs on, so a command printed here
 *  pastes there): POSIX quoting, or PowerShell's on Windows. Each argument is quoted only when it must be. */
export const shellLine = (args, platform = process.platform) => args.map((a) => (platform === "win32"
    ? (/^[\w%+=:,./\\-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "''")}'`)
    : (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`))).join(" ");

/** `cd <dir>` then `cmd`, joined as the shell of `platform` joins two commands (PowerShell's `;` on Windows). */
export const inDir = (dir, cmd, platform = process.platform) => `cd ${shellLine([dir], platform)}${platform === "win32" ? ";" : " &&"} ${cmd}`;

/** Held entries (the ledger's `held`) grouped by model × task × failure, largest group first. */
export function groupHeld(entries) {
    const groups = new Map();
    for (const e of entries.filter((x) => x.kind === "held")) {
        const key = [e.model ?? "?", e.task ?? "?", e.failure ?? "?"].join(" · ");
        (groups.get(key) ?? groups.set(key, { key, model: e.model ?? "?", task: e.task ?? "?", failure: e.failure ?? "?", runs: [] }).get(key)).runs.push(e);
    }
    return [...groups.values()].map((g) => ({ ...g, rss: g.runs.reduce((a, r) => a + (r.rss ?? 0), 0) }))
        .sort((a, b) => b.runs.length - a.runs.length || b.rss - a.rss);
}

const holdCmd = (repo, ...args) => inDir(repo, `node --import tsx tests/e2e/bench/hold.mjs ${args.join(" ")}`);

/** The commands for one group: `{ attach, keepOne?, release }`, each a line to paste. */
export function groupCommands(g) {
    const repo = g.runs[0].repo ?? ".";
    const pids = g.runs.map((r) => String(r.pid));
    return {
        attach: inDir(repo, `node tests/e2e/converse.mjs --attach ${shellLine([g.runs[0].dir])} "<message>"`),
        ...(pids.length > 1 ? { keepOne: holdCmd(repo, "--stop", ...pids.slice(1)) } : {}),
        release: holdCmd(repo, "--stop", ...pids),
    };
}

/**
 * The menu as text: the held groups with their commands, any run the budget did not hold (`wouldHold`), how to release
 * one, how to resume (`resume`, the sweep's own command line), and the hints. [] when nothing is held and nothing was
 * turned away.
 */
export function menuText(entries, { resume = null, wouldHold = [], paused = null } = {}) {
    const groups = groupHeld(entries);
    if (!groups.length && !wouldHold.length && !paused) return [];
    const held = groups.reduce((a, g) => a + g.runs.length, 0);
    const out = [];
    if (paused) out.push(`  PAUSED at the memory budget: ${paused}`, "");
    if (groups.length) {
        out.push(`  Held open: ${held} run${held === 1 ? "" : "s"}, ${fmtBytes(groups.reduce((a, g) => a + g.rss, 0))}, by model · task · failure:`);
        for (const g of groups) {
            const c = groupCommands(g);
            const row = (label, cmd) => `      ${`${label}:`.padEnd(28)} ${cmd}`;
            out.push(`    ${g.runs.length} × ${g.key}  (${fmtBytes(g.rss)}${g.runs[0].sweep ? `, sweep ${g.runs[0].sweep}` : ""})`,
                row("attach to one", c.attach),
                ...(c.keepOne ? [row("keep one, release the rest", c.keepOne)] : []),
                row(g.runs.length === 1 ? "release it" : `release all ${g.runs.length}`, c.release));
        }
        out.push(`    ${"release one by pid:".padEnd(30)} ${holdCmd(groups[0].runs[0].repo ?? ".", "--stop", "<pid>")}`);
    }
    if (wouldHold.length) {
        out.push(`  Not held (the budget had no room): ${wouldHold.length} run${wouldHold.length === 1 ? "" : "s"}; each one's run.md is in its directory:`);
        for (const w of wouldHold.slice(0, 12)) out.push(`    ${w.cell}  (${w.failure})`);
        if (wouldHold.length > 12) out.push(`    … and ${wouldHold.length - 12} more`);
    }
    if (resume) out.push(`  Resume the sweep (finished cells come from the cache): ${resume}`);
    out.push("  What to do with them:", ...HOLD_HINTS.map((h) => `    - ${h}`));
    return out;
}
