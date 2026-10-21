// build-pyodide-restricted.mjs — builds Pyodide's core from the restricted-mode CPython fork, so python_exec can
// run the dialect under wasm. Everything it pins (Pyodide tag, fork commit, emscripten, ABI) is read from
// tools/pyodide-dist.json, the one place the version lives; `npm run fetch-pyodide` reads the same file.
//
//   node tools/build-pyodide-restricted.mjs [--work tmp/pyodide-build] [--cpython ~/git/cpython-restricted] [--jobs 10] [--pin <file>]
//
// Takes hours (emsdk install + CPython + link). Run it in the background. Output: <work>/out/ (the five
// PYODIDE_CORE files), <work>/pyodide-restricted-<pyodide>-<sha8>.tar.gz, <work>/BUILD_REPORT.md, <work>/build.log.
// Traps found building it (do not rediscover): (1) emsdk builds ccache's bundled zstd, whose CMakeLists a CMake 4
// refuses, so make runs with CMAKE_POLICY_VERSION_MINIMUM=3.5; (2) Makefile.envs assigns PYTHON_ARCHIVE_SHA256 with `=`
// where the other pins use `?=`, so the pin check accepts both; (3) tools/dependency-check.sh never fails on BSD sed/patch,
// hence the GNU shim; (4) emsdk's emcc wrapper execs `ccache` from PATH, its ccache is unreachable once emsdk_env.sh strips its own PATH entries and segfaults on macOS arm64, so the shim dir carries a pass-through `ccache`.
// Builds `all-but-packages` only: the wheels are unchanged (the fork touches no object header), so
// pyodide-lock.json is copied from the stock npm package.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync, symlinkSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PIN_FILE = resolve(opt("--pin", join(ROOT, "tools/pyodide-dist.json"))); // a scratch pin tries a fork branch before it is merged
const WORK = resolve(opt("--work", join(ROOT, "tmp/pyodide-build")));
const CPYTHON_LOCAL = resolve(opt("--cpython", join(homedir(), "git/cpython-restricted")));
const JOBS = opt("--jobs", "10");

const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
for (const k of ["pyodide", "emscripten", "abi", "python", "pythonArchiveSha256"]) if (!pin[k]) throw new Error(`pin: ${k} missing in ${PIN_FILE}`);
for (const k of ["repo", "base", "commit"]) if (!pin.cpython?.[k]) throw new Error(`pin: cpython.${k} missing`);
const sha8 = pin.cpython.commit.slice(0, 8);
const tarName = `pyodide-restricted-${pin.pyodide}-${sha8}.tar.gz`;

const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o }).trim();
const which = b => { try { return run("which", [b]); } catch { return null; } };
const t0 = Date.now();
const phases = [];
const mark = name => { phases.push({ name, at: Math.round((Date.now() - t0) / 1000) }); console.log(`[${phases.at(-1).at}s] ${name}`); };

// --- preflight: tools, and GNU-ness of sed/patch (dependency-check.sh's own check never fires) ---
const GNU_DIRS = ["/opt/homebrew/opt/gnu-sed/libexec/gnubin", "/opt/homebrew/opt/gpatch/libexec/gnubin", "/usr/local/opt/gnu-sed/libexec/gnubin", "/usr/local/opt/gpatch/libexec/gnubin"];
const gnu = bin => {
    for (const d of [...GNU_DIRS, ...(process.env.PATH || "").split(":")]) {
        const p = join(d, bin);
        if (!existsSync(p)) continue;
        try { if (/GNU/.test(run(p, ["--version"]))) return p; } catch { /* try the next */ }
    }
    return null;
};
const need = { "python3.14": "python@3.14", node: "node", cmake: "cmake", autoreconf: "autoconf automake", "pkg-config": "pkgconf", git: "git", make: "make" };
const missing = Object.entries(need).filter(([b]) => !which(b)).map(([b, f]) => `${b} (brew install ${f})`);
const sed = gnu("sed"), patch = gnu("patch");
if (!sed) missing.push("GNU sed (brew install gnu-sed)");
if (!patch) missing.push("GNU patch (brew install gpatch)");
if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
mkdirSync(WORK, { recursive: true });
const shim = join(WORK, "shim");
rmSync(shim, { recursive: true, force: true });
mkdirSync(shim);
symlinkSync(sed, join(shim, "sed"));
symlinkSync(patch, join(shim, "patch"));
mark("preflight ok");

// --- the patch series, from the pinned fork commit ---
let src = CPYTHON_LOCAL;
const hasCommit = d => { try { run("git", ["-C", d, "cat-file", "-e", `${pin.cpython.commit}^{commit}`]); return true; } catch { return false; } };
if (!existsSync(join(src, ".git")) || !hasCommit(src)) { // format-patch needs the commit object, not a checkout of it
    src = join(WORK, "cpython-fork");
    if (!existsSync(join(src, ".git"))) run("git", ["clone", "--no-checkout", pin.cpython.repo, src]);
    run("git", ["-C", src, "fetch", "origin", pin.cpython.branch, "--tags"]);
    if (!hasCommit(src)) throw new Error(`the fork has no commit ${pin.cpython.commit}`);
}
const patchDir = join(WORK, "patches-out");
rmSync(patchDir, { recursive: true, force: true });
mkdirSync(patchDir);
run("git", ["-C", src, "format-patch", `${pin.cpython.base}..${pin.cpython.commit}`, "--start-number", String(pin.patches.startNumber), "-o", patchDir, "--", ".", ...pin.patches.exclude.map(e => `:(exclude)${e}`)]);
const series = readdirSync(patchDir).filter(f => f.endsWith(".patch")).sort();
if (series.length !== pin.patches.count) throw new Error(`expected ${pin.patches.count} patches, exported ${series.length}`);
series.forEach((f, i) => { if (!f.startsWith(String(pin.patches.startNumber + i).padStart(4, "0"))) throw new Error(`patch series not contiguous at ${f}`); });
mark(`exported ${series.length} patches`);

// --- Pyodide at the pinned tag ---
const pyo = join(WORK, "pyodide");
if (!existsSync(pyo)) run("git", ["clone", "--depth", "1", "--branch", pin.pyodide, "https://github.com/pyodide/pyodide", pyo]);
const envs = readFileSync(join(pyo, "Makefile.envs"), "utf8");
const envVar = n => envs.match(new RegExp(`^(?:export )?${n}\\s*\\??=\\s*(\\S+)`, "m"))?.[1];
for (const [n, want] of [["PYVERSION", pin.python], ["PYODIDE_EMSCRIPTEN_VERSION", pin.emscripten], ["PYODIDE_ABI_VERSION", pin.abi], ["PYTHON_ARCHIVE_SHA256", pin.pythonArchiveSha256]]) {
    if (envVar(n) !== want) throw new Error(`Makefile.envs ${n}=${envVar(n)} but the pin says ${want}: the tag moved or the pin is stale`);
}
const pdir = join(pyo, "cpython/patches");
for (const f of readdirSync(pdir)) if (/^00(1\d|2\d)-/.test(f)) rmSync(join(pdir, f)); // a re-run starts from 0001-0009
for (const f of series) copyFileSync(join(patchDir, f), join(pdir, f));
const all = readdirSync(pdir).filter(f => f.endsWith(".patch"));
if (all.length !== 9 + series.length) throw new Error(`cpython/patches holds ${all.length} patches, expected ${9 + series.length}`);
mark("patches installed");

// A tree last built from ANOTHER patch set is cleared from the patched source down. Pyodide's make applies the patches
// once, when it unpacks CPython, and skips CPython entirely while its install stamp and stdlib exist, so a moved fork
// commit otherwise packs the old interpreter under the new commit's name (2026-10-21: two 15 s "builds" of a new
// commit held none of its code). The stamp is written only after make succeeds.
const patchset = createHash("sha256");
for (const f of series) patchset.update(readFileSync(join(patchDir, f)));
const patchsetHash = patchset.digest("hex");
const patchsetStamp = join(pyo, "cpython/.ml-patchset");
if ((existsSync(patchsetStamp) ? readFileSync(patchsetStamp, "utf8").trim() : "") !== patchsetHash) {
    const inst = join(pyo, "cpython/installs", `python-${pin.python}`);
    const mm = pin.python.split(".").slice(0, 2).join(".");
    for (const p of [join(pyo, "cpython/build", `Python-${pin.python}`), join(inst, "lib", `python${mm}`),
        join(inst, "lib", `libpython${mm}.a`), join(inst, ".installed-pyodide")]) rmSync(p, { recursive: true, force: true });
    mark("patch set changed: CPython rebuilds from source");
}

// --- build (the hours) ---
// emsdk's emcc wrapper execs `ccache` from PATH, and emsdk_env.sh (sourced by cpython/Makefile) strips every PATH entry
// inside the emsdk tree. The ccache emsdk builds also segfaults on macOS arm64, and it is only a cache, so the shim dir
// carries a pass-through `ccache` that runs the compiler unchanged (trap 4).
writeFileSync(join(shim, "ccache"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
const log = createWriteStream(join(WORK, "build.log"));
const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, SED: sed, PYODIDE_JOBS: JOBS,
    CMAKE_POLICY_VERSION_MINIMUM: "3.5" }; // emsdk builds ccache's bundled zstd, whose CMakeLists a CMake 4 refuses
await new Promise((ok, bad) => {
    const p = spawn("make", ["-C", pyo, "all-but-packages"], { env });
    p.stdout.on("data", d => { log.write(d); process.stdout.write(d); });
    p.stderr.on("data", d => { log.write(d); process.stderr.write(d); });
    p.on("exit", c => c === 0 ? ok() : bad(new Error(`make all-but-packages exited ${c}; see ${join(WORK, "build.log")}`)));
});
mark("make all-but-packages done");
writeFileSync(patchsetStamp, patchsetHash + "\n");

// --- collect ---
const out = join(WORK, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of CORE) {
    const from = f === "pyodide-lock.json" ? join(ROOT, "node_modules/pyodide", f) : join(pyo, "dist", f);
    copyFileSync(from, join(out, f));
    if (!statSync(join(out, f)).size) throw new Error(`${f} is empty`);
}
// The witness: the core's restricted.py is the pinned commit's, byte for byte. A stale tree (the patch-set stamp above)
// once packed the previous commit's under this one's name, and nothing else in the build notices.
const packed = execFileSync("unzip", ["-p", join(out, "python_stdlib.zip"), "restricted.py"], { maxBuffer: 1 << 24 });
const pinned = execFileSync("git", ["-C", src, "show", `${pin.cpython.commit}:Lib/restricted.py`], { maxBuffer: 1 << 24 });
if (!packed.equals(pinned)) throw new Error(`python_stdlib.zip holds a restricted.py that is not ${sha8}'s: the CPython tree is stale`);
const restrictedPySha = createHash("sha256").update(pinned).digest("hex");
if (pin.cpython.restrictedPySha256 && pin.cpython.restrictedPySha256 !== restrictedPySha) {
    throw new Error(`the pin's cpython.restrictedPySha256 is not ${sha8}'s Lib/restricted.py (${restrictedPySha}): update it with the commit`);
}
const tar = join(WORK, tarName);
run("tar", ["-czf", tar, "-C", out, ...CORE]);
const sha = createHash("sha256").update(readFileSync(tar)).digest("hex");
mark("packed");

// --- report ---
const sizes = Object.fromEntries(CORE.map(f => [f, statSync(join(out, f)).size]));
const safe = (c, a) => { try { return run(c, a); } catch { return "n/a"; } };
const report = {
    pin, tar: tarName, sha256: sha, tarBytes: statSync(tar).size, sizes, wallSeconds: Math.round((Date.now() - t0) / 1000), phases,
    machine: { host: hostname(), uname: safe("uname", ["-a"]), cpu: safe("sysctl", ["-n", "machdep.cpu.brand_string"]), ncpu: safe("sysctl", ["-n", "hw.ncpu"]), os: safe("sw_vers", []) },
    tools: { emcc: safe("sh", ["-c", `${join(pyo, "emsdk/emsdk/upstream/emscripten/emcc")} --version | head -1`]), python: safe("python3.14", ["--version"]), node: process.version, git: safe("git", ["--version"]) },
    pyodideCommit: safe("git", ["-C", pyo, "rev-parse", "HEAD"]),
};
writeFileSync(join(WORK, "build-report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(WORK, "BUILD_REPORT.md"), `# Pyodide restricted build\n\n- artefact: ${tarName}\n- sha256: ${sha}\n- tarball: ${(report.tarBytes / 1e6).toFixed(1)} MB\n- wall time: ${report.wallSeconds}s\n- machine: ${report.machine.cpu}, ${report.machine.ncpu} cores\n- emcc: ${report.tools.emcc}\n\n## Sizes\n\n${CORE.map(f => `- ${f}: ${(sizes[f] / 1e6).toFixed(2)} MB`).join("\n")}\n\n## Phases (seconds from start)\n\n${phases.map(p => `- ${p.name}: ${p.at}`).join("\n")}\n`);
console.log(`\nDone. ${tar}\nsha256 ${sha}\nrestricted.py sha256 ${restrictedPySha}\nPut those in tools/pyodide-dist.json: artefact.sha256 and cpython.restrictedPySha256.`);
