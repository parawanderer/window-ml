// build-pin.test.mjs — build.mjs refuses a pyodide-core/ whose .pin disagrees with tools/pyodide-dist.json, and a refused build leaves dist/ byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Every file under `dir` as "relative path -> sha256", sorted: what "byte-identical" compares. */
function snapshot(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out.push(`${path.relative(dir, p)} ${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
        }
    };
    walk(dir);
    return out.sort();
}

// --- the pin check refuses before anything is replaced ---

test("a pyodide-core/ whose .pin disagrees with tools/pyodide-dist.json fails the build, names the mismatch, and leaves dist/ byte-identical", () => {
    // A copy of the tracked tree, so the real dist/ and pyodide-core/ are never touched; node_modules is shared.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-pin-"));
    try {
        const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split("\0").filter(Boolean);
        for (const f of tracked) {
            if (!fs.existsSync(path.join(ROOT, f))) continue;
            fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
            fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
        }
        fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"));
        fs.mkdirSync(path.join(tmp, "dist"));
        fs.writeFileSync(path.join(tmp, "dist/marker.txt"), "the previous build\n");
        fs.mkdirSync(path.join(tmp, "pyodide-core"));
        fs.writeFileSync(path.join(tmp, "pyodide-core/pyodide.mjs"), "");
        const pinned = JSON.parse(fs.readFileSync(path.join(tmp, "tools/pyodide-dist.json"), "utf8")).artefact.sha256;
        assert.ok(pinned, "the dist manifest pins a sha256, or the check has nothing to compare");
        const wrong = "0".repeat(64);
        assert.notEqual(wrong, pinned);
        fs.writeFileSync(path.join(tmp, "pyodide-core/.pin"), `pyodide-core.tar.gz ${wrong}\n`);

        const before = snapshot(path.join(tmp, "dist"));
        const r = spawnSync(process.execPath, ["build.mjs"], { cwd: tmp, encoding: "utf8", timeout: 240000 });
        assert.notEqual(r.status, 0, "the build fails");
        const out = r.stdout + r.stderr;
        assert.ok(out.includes(`holds sha256 ${wrong}`) && out.includes(`pins ${pinned}`), `the mismatch is named:\n${out.slice(-600)}`);
        assert.deepEqual(snapshot(path.join(tmp, "dist")), before, "dist/ is byte-identical");
        assert.equal(fs.existsSync(path.join(tmp, "dist.stage")), false, "the stage is cleaned up");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
