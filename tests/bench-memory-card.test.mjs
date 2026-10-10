// The sweep page's Memory card (tests/e2e/bench/page/memory.tsx), rendered from page state as report.html renders it:
// the budget line, the paused banner with its resume command, the chart of what the bench held over time, each held
// group with its commands as copyable code blocks, the runs the budget turned away, and when the card is not drawn at
// all; the copy button copying the exact command; and the stylesheet carrying what the card needs, its code-block
// padding winning over a code theme's even where the page scopes the theme.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { staticPage } from "../tests/e2e/bench/serve.mjs";
import { appCss } from "../tests/e2e/bench/page/bundle.mjs";

const GB = 1024 ** 3, MB = 1024 ** 2;
const RESUME = "cd /r && node --import tsx tests/e2e/bench/run.mjs s.bench.ts --hold failures";
const cmds = (pids) => ({
    attach: `cd /r && node tests/e2e/converse.mjs --attach tests/e2e/artifacts/bench/s/t/r${pids[0]} "<message>"`,
    ...(pids.length > 1 ? { keepOne: `cd /r && node --import tsx tests/e2e/bench/hold.mjs --stop ${pids.slice(1).join(" ")}` } : {}),
    release: `cd /r && node --import tsx tests/e2e/bench/hold.mjs --stop ${pids.join(" ")}`,
});
/** A paused sweep holding three runs in two groups, with a minute of readings. */
const MEMORY = {
    limit: 8 * GB, used: 5 * GB, byKind: { runner: 200 * MB, held: 3.5 * GB, running: 1.3 * GB }, available: 9 * GB, total: 16 * GB, reserve: 4 * GB, room: 3 * GB,
    active: true, whenFull: "pause", paused: "the memory limit: the bench holds 7.6 GB of 8.0 GB, and one more browser takes about 1.0 GB", resume: RESUME,
    hints: ["The same model failing the same way: keep one, release the duplicates.", "Do what you held them for now, then release them.", "Or whatever else the task needs."],
    runner: { rss: 200 * MB, heap: 90 * MB },
    groups: [
        { key: "glm-4.7-flash · icon-heart · step cap", count: 2, rss: 2.4 * GB, sweeps: ["cuts2"], commands: cmds([101, 102]) },
        { key: "minimax-m3 · csv-total · wrong answer", count: 1, rss: 1.1 * GB, sweeps: ["cuts2"], commands: cmds([201]) },
    ],
    wouldHold: [{ cell: "glm · csv-total · r3", task: "csv-total", model: "glm", failure: "timed out", dir: "a/b", why: "x" }],
    history: Array.from({ length: 13 }, (_, i) => ({ t: 1_760_000_000_000 + i * 5000, values: { runner: 200 * MB, held: Math.min(i, 3) * 1.1 * GB, running: 1.3 * GB }, room: 3 * GB })),
};
const runs = [{ combo: { model: "m" }, taskId: "t", repeat: 0, state: "done", who: "m", ok: false }];
const base = { name: "s", dims: ["model"], runs, rows: [], jobs: 1, started: 1_760_000_000_000, finished: 1_760_000_060_000 };

const opened = [];
/** The page for `state`, scripts run, with a clipboard that records what it was given. */
async function page(state) {
    const copied = [];
    const w = new JSDOM(await staticPage(state), { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true,
        beforeParse(win) { Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } } }); } }).window;
    opened.push(w);
    return { doc: w.document, copied, w };
}
test.after(() => opened.forEach((w) => w.close()));
const codeText = (el) => el.querySelector("pre.code").textContent;

// --- what the card shows ---

test("a paused sweep's card: the budget, the paused banner with the resume command, the header badge", async () => {
    const { doc } = await page({ ...base, memory: MEMORY });
    const card = doc.querySelector("#memory");
    assert.ok(card);
    assert.match(card.querySelector("header .sub").textContent, /5\.0 GB of a 8\.0 GB limit \(half the RAM, the default\) · 9\.0 GB available, 4\.0 GB kept free · room for 3\.0 GB/);
    const banner = card.querySelector(".mpaused");
    assert.match(banner.textContent, /Paused at the memory budget: the memory limit/);
    assert.equal(codeText(banner.querySelector(".copyable-code")), RESUME);
    assert.ok([...doc.querySelectorAll(".badge")].some((b) => b.textContent === "paused: memory"));
    assert.match(card.textContent, /held runs: 3\.5 GB/);
    assert.match(card.textContent, /node heap 90 MB/);
});

test("each held group: its count and key, and its commands as copyable code blocks, keep-one only where there are duplicates", async () => {
    const { doc } = await page({ ...base, memory: MEMORY });
    const groups = [...doc.querySelectorAll("#memory .mgroup")];
    assert.equal(groups.length, 2);
    const blocks = (g) => [...g.querySelectorAll(".mcmd")].map((r) => [r.querySelector("span").textContent, codeText(r)]);
    assert.match(groups[0].textContent, /^2 × glm-4\.7-flash · icon-heart · step cap \(2\.4 GB, cuts2\)/);
    assert.deepEqual(blocks(groups[0]), [["attach to one", cmds([101, 102]).attach], ["keep one, release the rest", cmds([101, 102]).keepOne], ["release all 2", cmds([101, 102]).release]]);
    assert.deepEqual(blocks(groups[1]).map(([l]) => l), ["attach to one", "release it"]);
    // Every command sits in the code block's container with its copy button, highlighted as shell.
    for (const b of doc.querySelectorAll("#memory .copyable-code")) {
        assert.ok(b.classList.contains("code-block") && b.querySelector(".code-tools button[aria-label=copy]"));
        assert.ok(b.querySelector("code.hljs .hljs-built_in, code.hljs .hljs-string, code.hljs .hljs-keyword"), "shell-highlighted");
    }
    assert.deepEqual([...doc.querySelectorAll("#memory .mhints li")].map((l) => l.textContent), MEMORY.hints);
    assert.match(doc.querySelector("#memory").textContent, /Not held: the budget had no room.*glm · csv-total · r3 \(timed out\)/s);
});

test("the copy button copies the command exactly and shows it was copied", async () => {
    const { doc, copied, w } = await page({ ...base, memory: MEMORY });
    const block = doc.querySelectorAll("#memory .mgroup")[0].querySelectorAll(".copyable-code")[1];
    block.querySelector(".code-tools button").click();
    await new Promise((r) => w.setTimeout(r, 20));
    assert.deepEqual(copied, [cmds([101, 102]).keepOne]);
    assert.equal(block.querySelector(".tt-pop").textContent, "copied!");
});

// --- the chart ---

test("the chart: one area per kind, stacked, over the sweep's readings, with its peak against the limit under it", async () => {
    const { doc } = await page({ ...base, memory: MEMORY });
    const chart = doc.querySelector("#memory .tc");
    assert.ok(chart);
    assert.deepEqual([...chart.querySelectorAll("svg path")].map((p) => p.getAttribute("class")), ["mem-runner", "mem-page", "mem-running", "mem-held"]);
    // The held band is the top one: its upper edge at the last reading is the total, the highest point drawn.
    const held = chart.querySelector("path.mem-held").getAttribute("d");
    assert.ok(held.startsWith("M"));
    assert.match(chart.querySelector(".tc-axis").textContent, /4\.8 GB peak of 8\.0 GB/);
    assert.match(chart.querySelector(".tc-plot").getAttribute("aria-label"), /peaking at 4\.8 GB of a 8\.0 GB limit/);
});

test("fewer than two readings draw no chart; the rest of the card stays", async () => {
    const { doc } = await page({ ...base, memory: { ...MEMORY, history: MEMORY.history.slice(0, 1) } });
    assert.equal(doc.querySelector("#memory .tc"), null);
    assert.ok(doc.querySelector("#memory .mgroup"));
    const { doc: old } = await page({ ...base, memory: { ...MEMORY, history: undefined } });
    assert.ok(old.querySelector("#memory"), "a page.json from before the history renders");
});

// --- when there is no card ---

test("no memory state, or an inactive budget with nothing held, draws no card; something held by another clone does", async () => {
    assert.equal((await page(base)).doc.querySelector("#memory"), null);
    const quiet = { ...MEMORY, active: false, paused: null, groups: [], wouldHold: [] };
    assert.equal((await page({ ...base, memory: quiet })).doc.querySelector("#memory"), null);
    assert.ok((await page({ ...base, memory: { ...quiet, groups: MEMORY.groups } })).doc.querySelector("#memory .mgroup"));
});

test("a hand-set limit keeps nothing free, and the card says so rather than '0 MB kept free'", async () => {
    const { doc } = await page({ ...base, memory: { ...MEMORY, reserve: 0 } });
    const sub = doc.querySelector("#memory header .sub").textContent;
    assert.match(sub, /no reserve \(a limit set by hand\)/);
    assert.doesNotMatch(sub, /0 MB kept free/);
});

// --- the stylesheet ---

/** CSS specificity as [ids, classes + attributes + pseudo-classes, elements], counting inside :not(). */
function specificity(sel) {
    const s = sel.replace(/:not\(([^)]*)\)/g, " $1");
    return [(s.match(/#[\w-]+/g) ?? []).length, (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length, (s.replace(/\[[^\]]*\]|[.#:][\w-]+/g, " ").match(/\b[a-z][\w-]*/gi) ?? []).length];
}
const beats = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

test("the page's stylesheet has the code block, copy button and chart rules, and the command padding outranks every theme rule padding a pre's code", async () => {
    const css = await appCss();
    for (const sel of [".copyable-code .code {", ".code-tools {", ".icon-btn {", ".tc-plot {", ".tc-axis {", ".mem-held {"]) assert.ok(css.includes(sel), sel);
    const ours = specificity(".code-block.copyable-code pre.code code.hljs");
    assert.ok(css.includes(".code-block.copyable-code pre.code code.hljs { padding: 0"));
    // Every rule that pads a code.hljs inside a pre, as the page has it (the theme scoped under :root:not(…) included).
    const theirs = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, sel, body]) => /padding/.test(body) && /pre[^,{]*code\.hljs/.test(sel))
        .flatMap(([, sel]) => sel.split(",").map((x) => x.trim())).filter((x) => /pre.*code\.hljs/.test(x) && !x.includes("copyable-code"));
    assert.ok(theirs.some((x) => x.startsWith(":root")), "the scoped theme rule is there to beat");
    for (const t of theirs) assert.ok(beats(ours, specificity(t)) > 0, `${t} outranks the command padding`);
});

test("the card and each held group fold under their chevron, and a folded group stays folded on the next page", async () => {
    const { doc, w } = await page({ ...base, memory: MEMORY });
    const card = doc.querySelector("#memory");
    assert.ok(card.classList.contains("fold") && card.querySelector(":scope > .foldbtn"), "the card folds like the page's other cards");
    const group = doc.querySelectorAll("#memory .mgroup")[0];
    const btn = group.querySelector(":scope > .foldbtn");
    assert.equal(btn.getAttribute("aria-expanded"), "true");
    btn.click();
    await new Promise((r) => w.setTimeout(r, 10));
    assert.ok(group.classList.contains("folded"));
    assert.equal(btn.getAttribute("aria-expanded"), "false");
    assert.equal(doc.querySelectorAll("#memory .mgroup")[1].classList.contains("folded"), false, "only the one clicked");
    // Remembered by the group's key, so the same group on a reload (or the next sweep's page) opens folded.
    assert.ok(JSON.parse(w.localStorage.getItem("benchFolded")).includes("memory-group:glm-4.7-flash · icon-heart · step cap"));
});
