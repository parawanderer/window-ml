// redteam-exec-page-leg.test.mjs — a read-only survey's PAGE leg (src/sw/sw-run-host.ts `tryReadonly`, `pageLegOk`): a
// script policy keeps out of the page's main world — one naming `ml.current`, `ml.sh` or a pointer — is never handed to
// the page to evaluate, even when the worker's own survey comes back `needs-page` (docs/spec/SITE_ACCESS.md, part 4;
// docs/spec/SHELL.md). The page leg is decided on the SCRIPT alone, so only a script that names none of them has one.
// A page the person has not approved is decided by the SITE, not the script: a survey their own run makes there keeps
// its page leg (the site-access invariant), which is the positive row below.
//
// The survey is the one path that runs a script for the page to see: the page's mediated interpreter lives in its main
// world, so a call that reaches it hands over whatever the script names. Every reason the routing module exports is
// placed in one of the duties below, so a reason added later fails the last row until somebody says which it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";

const T = { timeout: 30000 };

/** One script per reason the page's world must never see: what a model would write for each mechanism. */
const SCRIPT_NAMED = {
    sh: 'return (await ml.sh.run(["ls"])).code',
    // A bogus id: the WORKER answers the fault, which is the point — the leg is decided before the read is resolved.
    pointer: "return @tool:probe.length",
    current: "return ml.current.messages.length",
};
/** Each reason's duty for the page leg. A reason not named here reds the last row: place it, do not sample it. */
const DUTY = {
    plain: "page",              // nothing forced: the page surveys it, which is the whole point of the leg
    sh: "never",
    current: "never",
    pointer: "never",
    requested: "call",          // the call's `world`, decided by the call not the script (exec-world.test.mjs)
    default: "setting",         // the stored default world (exec-world.test.mjs)
    "unapproved-page": "site",  // the page's approval: a user-started run's survey keeps its leg there
};
const PLAIN = "return document.title.length";

/** Run one survey: what the page was asked to evaluate, and what routing recorded. */
async function survey(js, { approved = true } = {}) {
    const r = await runOn("readonly", [() => js], { localExtra: approved ? {} : { ml_site_always: [] } });
    const tries = r.bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.readonlyTry).map(([, m]) => JSON.parse(JSON.stringify(m.payload)));
    return { tries, ro: r.log.filter((e) => /^readonly-/.test(e.kind)).map((e) => [e.kind, e.reason]), log: r.log.map((e) => [e.kind, e.reason]) };
}

// --- the instrument, and the leg the page is supposed to take ---

test("CONTROL: a plain survey reaches the page's leg, which evaluates it, and no gate is asked", T, async () => {
    const r = await survey(PLAIN);
    assert.equal(r.tries.length, 1, "the page was never asked to survey: the instrument cannot see the page leg at all");
    // The fake page refuses the try, so the record is `refused-in-page`; a page that answered would record `reads-page`.
    assert.deepEqual(r.ro, [["readonly-page", "refused-in-page"]], "the run log does not say the page surveyed it");
});

// --- a script the policy isolates never reaches the page ---

for (const [reason, js] of Object.entries(SCRIPT_NAMED)) {
    // A hole is open for `sh` on main: the worker's survey comes back `needs-page` (its `ml` has no `ml.sh`), and the
    // page leg runs, so the page's main world evaluates a script that reaches the process host. Measured: the records
    // are `readonly-page / refused-in-page` then `exec-refused / sh`. Flip this to a plain test with the fix.
    test(`RED TEAM: a survey naming ${reason} is never handed to the page to evaluate`, reason === "sh" ? { ...T, todo: true } : T, async () => {
        const r = await survey(js);
        assert.equal(r.tries.length, 0, `the page was asked to evaluate a script policy isolates for ${reason}: ${JSON.stringify(r.tries.map((p) => p.args))}`);
        assert.deepEqual(r.ro.filter(([k]) => k === "readonly-page"), [], `the run log says the page surveyed it: ${JSON.stringify(r.ro)}`);
    });
}

// --- the page's own approval is the SITE's decision, not the script's ---

test("RED TEAM: a survey on an unapproved page keeps its page leg: the run is the person's, and the site is what is unapproved", T, async () => {
    const r = await survey(PLAIN, { approved: false });
    assert.equal(r.tries.length, 1, "an unapproved page lost the read-only leg its own run is allowed");
    assert.deepEqual(r.ro.map(([k]) => k), ["readonly-page"]);
    assert.ok(r.log.some(([k, why]) => k === "exec-refused" && why === "unapproved-page"), `the exec's own route is not the site's: ${JSON.stringify(r.log)}`);
});

// --- every reason: placed, or this row fails ---

test("RED TEAM: every reason the routing module exports is placed, and each script-named one is one of the rows above", { todo: true }, async () => {
    const route = await import("../src/sw/exec-routing.ts");
    const reasons = route.EXEC_REASONS;
    assert.ok(Array.isArray(reasons) && reasons.length, "exec-routing.ts does not export EXEC_REASONS as a runtime list");
    assert.deepEqual([...reasons].sort(), Object.keys(DUTY).sort(), `a reason has no duty here: ${JSON.stringify(reasons.filter((r) => !(r in DUTY)))}`);
    // What `routeExec` reads off a script is what the page leg is decided on: a name there is a `never` above.
    const names = Object.keys(route.execNames('return (await ml.sh.run(["ls"])).code + ml.current.messages.length + @tool:x.length')).sort();
    const byName = { current: "current", pointers: "pointer", sh: "sh" };
    assert.deepEqual(names, Object.keys(byName).sort(), "execNames gained a name whose reason is not placed");
    for (const n of names) assert.equal(DUTY[byName[n]], "never", `execNames reads ${JSON.stringify(n)}, whose reason is not a never`);
    for (const [reason, duty] of Object.entries(DUTY)) if (duty === "never") assert.ok(reason in SCRIPT_NAMED, `${reason} is a never with no script above`);
});
