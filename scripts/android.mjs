// android.mjs — THE PHONE APP ON AN EMULATOR, from the command line: set the SDK up, boot a device, build and install
// the app, and point Playwright or a screenshot at it. A self-tool (skill: .claude/skills/android/SKILL.md), OPTIONAL
// like everything mobile: nothing in `npm test` or the chat suites needs it (CONTRIBUTING.md, "The mobile clients").
//
//   node scripts/android.mjs doctor          what is installed and what is missing, and the command for each
//   node scripts/android.mjs setup           the SDK packages and one emulator (`wml-phone`), once
//   node scripts/android.mjs boot [--window] start the emulator (headless unless --window) and wait for it to boot
//   node scripts/android.mjs install         build the web app, sync it into android/, build the APK, install it
//   node scripts/android.mjs launch          start the app (cold: it is stopped first)
//   … install --next [--demo] / launch --next   the same for the React Native app in mobile/ (docs/spec/NATIVE_SHELL.md),
//                                            `--demo` carrying the fake-host demo page instead of this device's account
//   node scripts/android.mjs shot [file]     a screenshot of the device (default test-results/android.png)
//   node scripts/android.mjs flows [file…]   run Maestro flows (default: every tests/mobile/*.yaml) against the device
//   node scripts/android.mjs stop            shut the emulator down
//
// Every step works against a real phone too, when it is the only device adb sees (USB debugging on); `boot` is then
// unnecessary. The SDK is the command-line one (`brew install --cask android-commandlinetools`), not Android Studio.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "/opt/homebrew/share/android-commandlinetools";
const API = 35;
/** The emulator's system image. Newer than the build's API level on purpose: an image carries the WebView it shipped with
 *  and cannot update it (no Play Store), and API 35's is Chrome 124, which has no Ed25519 or X25519 in WebCrypto. The
 *  hub's crypto needs both (Chrome 137+); a real phone updates its WebView from the Play Store. */
const IMAGE_API = "37.0";
const IMAGE = `system-images;android-${IMAGE_API};google_apis;arm64-v8a`;
const PACKAGES = ["platform-tools", "emulator", `platforms;android-${API}`, "build-tools;35.0.0", IMAGE];
const AVD = "wml-phone";
const NEXT = process.argv.includes("--next");
const APP = NEXT ? "dev.wander.windowml.next" : "dev.wander.windowml";

/** The JDK gradle is run with: 21, because Capacitor's Android library targets it and a newer default can break gradle. */
function javaHome() {
    const r = spawnSync("/usr/libexec/java_home", ["-v", "21"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : process.env.JAVA_HOME;
}
const env = { ...process.env, ANDROID_HOME: HOME, ANDROID_SDK_ROOT: HOME, ...(javaHome() ? { JAVA_HOME: javaHome() } : {}) };
const bin = {
    adb: path.join(HOME, "platform-tools/adb"),
    emulator: path.join(HOME, "emulator/emulator"),
    sdkmanager: "sdkmanager",
    avdmanager: "avdmanager",
};

/** Run a command to completion, inheriting the terminal; exit with its status when it fails. */
function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: "inherit", env, ...opts });
    if (r.status !== 0) { console.error(`✗ ${cmd} ${args.join(" ")} exited ${r.status}`); process.exit(r.status ?? 1); }
}
/** Run a command and return its stdout (empty on failure). */
const out = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env }).stdout?.trim() ?? "";
/** The Maestro CLI: on the PATH, or where its release zip unpacks (`~/.maestro/maestro/bin`). */
const maestro = () => out("which", ["maestro"]) || [path.join(process.env.HOME ?? "", ".maestro/maestro/bin/maestro")].find((p) => existsSync(p)) || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function doctor() {
    const checks = [
        ["JDK 21", !!javaHome(), "brew install --cask temurin@21"],
        ["sdkmanager", !!out("which", ["sdkmanager"]), "brew install --cask android-commandlinetools"],
        ["adb (platform-tools)", existsSync(bin.adb), "node scripts/android.mjs setup"],
        ["emulator", existsSync(bin.emulator), "node scripts/android.mjs setup"],
        [`system image (API ${IMAGE_API}, arm64)`, existsSync(path.join(HOME, "system-images", `android-${IMAGE_API}`)), "node scripts/android.mjs setup"],
        [`emulator "${AVD}"`, out(bin.emulator, ["-list-avds"]).split("\n").includes(AVD), "node scripts/android.mjs setup"],
        ["Maestro (mobile.dev)", !!maestro(), "the release zip into ~/.maestro (CONTRIBUTING.md); NOT the `maestro` cask, a different app"],
    ];
    for (const [name, ok, fix] of checks) console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `   → ${fix}`}`);
    const devices = existsSync(bin.adb) ? out(bin.adb, ["devices"]).split("\n").slice(1).filter(Boolean) : [];
    console.log(devices.length ? `devices: ${devices.join(", ")}` : "devices: none (boot one, or plug a phone in with USB debugging on)");
}

function setup() {
    spawnSync("sh", ["-c", `yes | sdkmanager --licenses >/dev/null`], { env, stdio: "ignore" });
    run(bin.sdkmanager, ["--install", ...PACKAGES]);
    // An emulator on an older image is recreated: the image decides the WebView, and the WebView decides the crypto.
    const ini = path.join(process.env.HOME ?? "", ".android", "avd", `${AVD}.avd`, "config.ini");
    if (existsSync(ini) && !readFileSync(ini, "utf8").includes(`android-${IMAGE_API}`)) run(bin.avdmanager, ["delete", "avd", "-n", AVD]);
    if (!out(bin.emulator, ["-list-avds"]).split("\n").includes(AVD)) {
        run(bin.avdmanager, ["create", "avd", "-n", AVD, "-k", IMAGE, "-d", "pixel_7"], { input: "no\n", stdio: ["pipe", "inherit", "inherit"] });
    }
    console.log(`✓ SDK packages and the "${AVD}" emulator are in place`);
}

async function boot(window) {
    if (out(bin.adb, ["devices"]).includes("emulator-")) { console.log("an emulator is already running"); return; }
    const args = ["-avd", AVD, "-no-snapshot-save", "-no-boot-anim", ...(window ? [] : ["-no-window", "-no-audio"])];
    const child = spawn(bin.emulator, args, { env, detached: true, stdio: "ignore" });
    child.unref();
    run(bin.adb, ["wait-for-device"]);
    for (let i = 0; i < 120; i++) {
        if (out(bin.adb, ["shell", "getprop", "sys.boot_completed"]) === "1") { console.log("✓ booted"); return; }
        await sleep(1000);
    }
    console.error("✗ the emulator did not finish booting in two minutes");
    process.exit(1);
}

/**
 * The React Native app: the page built and synced into it, then a release APK (the JS bundled in, so no Metro) and
 * installed. The previous JS bundle is deleted first: gradle tracks only files under mobile/, so a change to the shared
 * src/native/ would otherwise leave the old bundle in place and the build would look like it did nothing.
 */
function installNext() {
    run("node", ["scripts/build-web.mjs"]);
    run("node", ["mobile/scripts/sync-embed.mjs", ...(process.argv.includes("--demo") ? ["--demo"] : [])]);
    if (!existsSync("mobile/android")) run("npx", ["expo", "prebuild", "--platform", "android", "--no-install"], { cwd: "mobile" });
    spawnSync("rm", ["-rf", "mobile/android/app/build/generated/assets/react/release"]);
    run("./gradlew", ["assembleRelease", "--quiet"], { cwd: "mobile/android" });
    run(bin.adb, ["install", "-r", "mobile/android/app/build/outputs/apk/release/app-release.apk"]);
    console.log(`✓ installed ${APP}`);
}

function install() {
    if (NEXT) return installNext();
    run("node", ["scripts/build-web.mjs"]);
    run("node", ["scripts/mobile.mjs", "android"]);
    run("./gradlew", ["assembleDebug", "--quiet"], { cwd: "android" });
    run(bin.adb, ["install", "-r", "android/app/build/outputs/apk/debug/app-debug.apk"]);
    console.log(`✓ installed ${APP}`);
}

function launch() {
    run(bin.adb, ["shell", "am", "force-stop", APP]);
    // By its activity, not `monkey`, whose launcher lookup exits 251 on a fresh emulator image.
    run(bin.adb, ["shell", "am", "start", "-W", "-n", `${APP}/.MainActivity`], { stdio: "ignore" });
    console.log(`✓ launched ${APP}`);
}

function shot(file = "test-results/android.png") {
    mkdirSync(path.dirname(file), { recursive: true });
    const r = spawnSync(bin.adb, ["exec-out", "screencap", "-p"], { env, maxBuffer: 64 << 20 });
    if (r.status !== 0 || !r.stdout?.length) { console.error("✗ no screenshot: is a device connected?"); process.exit(1); }
    writeFileSync(file, r.stdout);
    console.log(`✓ ${file}`);
}

/** Maestro against the connected device: the given flows, or every one in tests/mobile/. */
function flows(files) {
    const m = maestro();
    if (!m) { console.error("✗ Maestro is not installed (node scripts/android.mjs doctor)"); process.exit(1); }
    const targets = files.length ? files : ["tests/mobile"];
    // No analytics prompt: its first-run banner made the first invocation exit 1 with every flow unrun.
    run(m, ["test", ...targets], { env: { ...env, PATH: `${path.dirname(bin.adb)}:${process.env.PATH}`, MAESTRO_CLI_NO_ANALYTICS: "1", MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true" } });
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
    case "doctor": doctor(); break;
    case "setup": setup(); break;
    case "boot": await boot(process.argv.includes("--window")); break;
    case "install": install(); break;
    case "launch": launch(); break;
    case "shot": shot(arg); break;
    case "flows": flows(process.argv.slice(3)); break;
    case "stop": run(bin.adb, ["emu", "kill"]); break;
    default:
        console.error("usage: node scripts/android.mjs <doctor|setup|boot [--window]|install|launch|shot [file]|flows [file…]|stop>");
        process.exit(2);
}
