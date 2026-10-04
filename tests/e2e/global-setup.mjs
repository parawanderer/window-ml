// global-setup.mjs — the one thing every Playwright spec passes through, used to refuse a run against a stale bundle.
//
// A spec hands a BUILT directory to a real browser, so a source edit without a rebuild is invisible: the suite runs
// the previous build and its result describes that instead. Nothing about the output says so. Checking it here rather
// than in each spec is the point — there is no way to add a spec that forgets.

import { stalenessReport } from "../../scripts/check-dist-fresh.mjs";

export default function globalSetup() {
    const report = stalenessReport();
    if (report) throw new Error(`\n${report}\n`);
}
