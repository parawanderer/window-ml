#!/usr/bin/env node
// test-isolated-bundle.mjs — runs every suite that loads the page-side bundle (`loadPageWorld`) against
// injected-isolated.js, the same tools in the content scripts' world (docs/spec/SITE_PRESENCE.md, step 3).
//
//   node scripts/test-isolated-bundle.mjs     # needs a fresh dist (node build.mjs)
//
// The files are found by name, not listed, so a new suite that loads the page world is covered without an edit here.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "tests");
const files = fs.readdirSync(dir)
    .filter((f) => /\.test\.(m?js)$/.test(f) && fs.readFileSync(path.join(dir, f), "utf8").includes("loadPageWorld("))
    .map((f) => `tests/${f}`);
if (!files.length) { console.error("test-isolated-bundle: no suite calls loadPageWorld"); process.exit(1); }
const r = spawnSync(process.execPath, ["scripts/test.mjs", "--files", ...files], {
    cwd: root, stdio: "inherit", env: { ...process.env, WML_PAGE_BUNDLE: "injected-isolated.js" },
});
process.exit(r.status ?? 1);
