// node-pin.test.mjs — the one Node version the repo runs on (.nvmrc) is the one `engines`, the test runner and every CI job
// use. A job left on a literal version tests something other than what development runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PINNED = read(".nvmrc").trim();

// --- the pin, in each place that names a Node version ---

test(".nvmrc is a bare major version", () => {
    assert.match(PINNED, /^\d+$/);
});

test("package.json's engines asks for the pinned major or newer, and npm enforces it", () => {
    assert.equal(JSON.parse(read("package.json")).engines?.node, `>=${PINNED}`);
    assert.match(read(".npmrc"), /^engine-strict=true$/m);
});

test("every CI job reads .nvmrc; the unit leg's matrix, which names the required check, equals it", () => {
    for (const f of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((n) => /\.ya?ml$/.test(n))) {
        const wf = read(`.github/workflows/${f}`);
        assert.doesNotMatch(wf, /node-version:\s*['"]?\d/, `${f} names a Node version instead of reading .nvmrc`);
    }
    assert.match(read(".github/workflows/tests.yml"), new RegExp(`\\n\\s*node: \\[${PINNED}\\]\\n`), "test (node N) must be the pinned N");
});

test("every CI job that runs node sets the pinned one up first, rather than taking the runner's", () => {
    for (const f of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((n) => /\.ya?ml$/.test(n))) {
        const jobs = read(`.github/workflows/${f}`).split(/\n(?=  [\w-]+:\n)/).slice(1);
        for (const job of jobs) {
            const name = job.split(":")[0].trim();
            if (/(?:^|\s|")(?:node|npm|npx) /m.test(job)) assert.match(job, /setup-node@/, `${f}: job ${name} runs node without actions/setup-node`);
        }
    }
});

test("the test runner refuses a Node older than the pin", () => {
    assert.match(read("scripts/test.mjs"), /readFileSync\(path\.join\(ROOT, "\.nvmrc"\)/);
});
