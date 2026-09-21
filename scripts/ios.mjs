// ios.mjs — THE PHONE APP ON AN iOS SIMULATOR, the counterpart of android.mjs with the same commands: boot a
// simulator, build and install the app, launch it, screenshot it, run the Maestro flows. A self-tool (skill:
// .claude/skills/phone/SKILL.md, which covers both), OPTIONAL like everything mobile, and macOS only (Xcode).
//
//   node scripts/ios.mjs doctor          what is installed and missing; the simulator it would use
//   node scripts/ios.mjs boot [--window] boot the simulator (Simulator.app opens only with --window)
//   node scripts/ios.mjs install         build the web app, sync it into ios/, xcodebuild for the simulator, install
//   node scripts/ios.mjs launch          start the app (cold: terminated first)
//   node scripts/ios.mjs shot [file]     a screenshot (default test-results/ios.png)
//   node scripts/ios.mjs flows [file…]   the Maestro flows (default every tests/mobile/*.yaml) against the simulator
//   node scripts/ios.mjs stop            shut the simulator down
//   … install --next [--demo] / launch --next   the same for the React Native app in mobile/ (docs/spec/NATIVE_SHELL.md)
//
// The simulator is the newest iPhone on the newest iOS runtime installed, or `IOS_DEVICE=<name or UDID>`. No signing
// certificate is needed for a simulator build; the project uses Swift Package Manager, so no CocoaPods either.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ensurePrebuild } from "./mobile-prebuild.mjs";

const NEXT = process.argv.includes("--next");
const APP = NEXT ? "dev.wander.windowml.next" : "dev.wander.windowml";
const BUILT = "ios/build/Build/Products/Debug-iphonesimulator/App.app";
const BUILT_NEXT = "mobile/ios/build/Build/Products/Release-iphonesimulator/windowml.app";

/** Run a command to completion, inheriting the terminal; exit with its status when it fails. */
function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
    if (r.status !== 0) { console.error(`✗ ${cmd} ${args.join(" ")} exited ${r.status}`); process.exit(r.status ?? 1); }
}
/** Run a command and return its stdout (empty on failure). */
const out = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() ?? "";
/** The Maestro CLI: on the PATH, or where its release zip unpacks (`~/.maestro/maestro/bin`). */
const maestro = () => out("which", ["maestro"]) || [path.join(process.env.HOME ?? "", ".maestro/maestro/bin/maestro")].find((p) => existsSync(p)) || "";

/** JDK 21 for Maestro, which warns about final-field mutation on anything newer. */
const jdk21 = () => out("/usr/libexec/java_home", ["-v", "21"]);

/** The simulator to use: `IOS_DEVICE` by name or UDID, else the last-listed iPhone on the newest iOS runtime. */
function device() {
    let list;
    try { list = JSON.parse(out("xcrun", ["simctl", "list", "devices", "available", "-j"])).devices; } catch { return null; }
    const runtimes = Object.keys(list).filter((r) => /SimRuntime\.iOS-/.test(r)).sort((a, b) => {
        const v = (r) => r.split("iOS-")[1].split("-").map(Number);
        const [x, y] = [v(a), v(b)];
        return x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0);
    });
    const want = process.env.IOS_DEVICE;
    for (const r of runtimes.reverse()) {
        const phones = list[r].filter((d) => /iPhone/.test(d.name));
        const hit = want ? list[r].find((d) => d.name === want || d.udid === want) : phones.at(-1);
        if (hit) return { ...hit, runtime: r.split("SimRuntime.")[1] };
    }
    return null;
}

function doctor() {
    const d = device();
    const checks = [
        ["macOS", process.platform === "darwin", "an iOS simulator needs a Mac"],
        ["Xcode", !!out("xcodebuild", ["-version"]).startsWith("Xcode"), "App Store → Xcode, then CONTRIBUTING.md 4b"],
        ["an iPhone simulator", !!d, "xcodebuild -downloadPlatform iOS"],
        ["Maestro (mobile.dev)", !!maestro(), "the release zip into ~/.maestro (CONTRIBUTING.md)"],
    ];
    for (const [name, ok, fix] of checks) console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `   → ${fix}`}`);
    if (d) console.log(`simulator: ${d.name} (${d.runtime}, ${d.state}) ${d.udid}`);
}

/** The simulator, or exit saying how to get one. */
function need() {
    const d = device();
    if (!d) { console.error("✗ no iPhone simulator (node scripts/ios.mjs doctor)"); process.exit(1); }
    return d;
}

function boot(window) {
    const d = need();
    if (d.state !== "Booted") run("xcrun", ["simctl", "boot", d.udid]);
    run("xcrun", ["simctl", "bootstatus", d.udid, "-b"], { stdio: "ignore" });
    if (window) run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", d.udid]);
    console.log(`✓ booted ${d.name}`);
}

/** The React Native app: the page built and synced into it, the native project generated (with the UIScene plugin iOS 27
 *  needs, and again whenever the app's native inputs change: mobile-prebuild.mjs) and its pods installed, a Release build (the JS bundled in, no Metro), installed. */
function installNext() {
    const d = need();
    run("node", ["scripts/build-web.mjs"]);
    run("node", ["mobile/scripts/sync-embed.mjs", ...(process.argv.includes("--demo") ? ["--demo"] : [])]);
    const fresh = ensurePrebuild("ios", run);
    if (fresh || !existsSync("mobile/ios/Pods")) run("pod", ["install"], { cwd: "mobile/ios" });
    run("xcodebuild", ["-workspace", "windowml.xcworkspace", "-scheme", "windowml", "-configuration", "Release", "-sdk", "iphonesimulator",
        "-destination", `id=${d.udid}`, "-derivedDataPath", "build", "-quiet", "build"], { cwd: "mobile/ios" });
    run("xcrun", ["simctl", "install", d.udid, BUILT_NEXT]);
    console.log(`✓ installed ${APP} on ${d.name}`);
}

function install() {
    if (NEXT) return installNext();
    const d = need();
    run("node", ["scripts/build-web.mjs"]);
    run("node", ["scripts/mobile.mjs", "ios"]);
    run("xcodebuild", ["-project", "ios/App/App.xcodeproj", "-scheme", "App", "-sdk", "iphonesimulator",
        "-destination", `id=${d.udid}`, "-derivedDataPath", "ios/build", "-quiet", "build"]);
    run("xcrun", ["simctl", "install", d.udid, BUILT]);
    console.log(`✓ installed ${APP} on ${d.name}`);
}

function launch() {
    const d = need();
    spawnSync("xcrun", ["simctl", "terminate", d.udid, APP], { stdio: "ignore" });
    run("xcrun", ["simctl", "launch", d.udid, APP], { stdio: "ignore" });
    console.log(`✓ launched ${APP}`);
}

function shot(file = "test-results/ios.png") {
    mkdirSync(path.dirname(file), { recursive: true });
    run("xcrun", ["simctl", "io", need().udid, "screenshot", file], { stdio: "ignore" });
    console.log(`✓ ${file}`);
}

/** Maestro against the booted simulator: the given flows, or every one in tests/mobile/. */
function flows(files) {
    const m = maestro();
    if (!m) { console.error("✗ Maestro is not installed (node scripts/ios.mjs doctor)"); process.exit(1); }
    run(m, ["--device", need().udid, "test", ...(files.length ? files : ["tests/mobile"])], {
        env: { ...process.env, ...(jdk21() ? { JAVA_HOME: jdk21() } : {}), MAESTRO_CLI_NO_ANALYTICS: "1", MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true" },
    });
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
    case "doctor": doctor(); break;
    case "boot": boot(process.argv.includes("--window")); break;
    case "install": install(); break;
    case "launch": launch(); break;
    case "shot": shot(arg); break;
    case "flows": flows(process.argv.slice(3)); break;
    case "stop": run("xcrun", ["simctl", "shutdown", need().udid]); break;
    default:
        console.error("usage: node scripts/ios.mjs <doctor|boot [--window]|install|launch|shot [file]|flows [file…]|stop>");
        process.exit(2);
}
