#!/usr/bin/env node
// check-glsl.mjs — TYPE-CHECK THE SHADERS without a browser: every assembled shader the gradient renderer compiles
// (`GRADIENT_SHADERS`, src/lab/gradient/gradient-gl.ts) goes through glslangValidator, Khronos's reference compiler for
// OpenGL ES, as GLSL ES 3.00 (WebGL2's dialect).
//
//   node scripts/check-glsl.mjs
//
// The sources are ASSEMBLED from shared pieces (`${HERMITE}`, `${OUTPUT}`), which is why this imports the module
// rather than grepping the `/* glsl */` literals: a fragment on its own is not a shader. The e2e spec
// (tests/e2e/gradient-shader.spec.mjs) also compiles them, in Chromium's own compiler; this is the fast check before it.
//
// glslangValidator is an optional tool: `brew install glslang`, or `apt-get install glslang-tools`. Without it this
// says so and exits 0, as the hub tests skip without `wmlhub`; CI installs it, so CI always checks.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRADIENT_SHADERS } from "../src/lab/gradient/gradient-gl.ts";

const BIN = process.env.GLSLANG ?? "glslangValidator";
try { execFileSync(BIN, ["--version"], { stdio: "ignore" }); } catch {
    console.log(`check-glsl: SKIPPED, ${BIN} is not installed (brew install glslang, or apt-get install glslang-tools)`);
    process.exit(process.env.CI ? 1 : 0);
}

const dir = mkdtempSync(path.join(tmpdir(), "glsl-"));
let failed = 0, checked = 0;
try {
    for (const [name, stages] of Object.entries(GRADIENT_SHADERS)) {
        for (const [stage, src] of Object.entries(stages)) {
            const file = path.join(dir, `${name}.${stage}`);
            writeFileSync(file, src);
            const r = spawnSync(BIN, [file], { encoding: "utf8" });
            checked++;
            if (r.status !== 0) {
                failed++;
                console.error(`✗ ${name}.${stage}\n${(r.stdout + r.stderr).replaceAll(file, `${name}.${stage}`).trim()}`);
            }
        }
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.error(`check-glsl: ${failed} of ${checked} shader(s) failed`); process.exit(1); }
console.log(`check-glsl: ${checked} shader(s) clean`);
