// mobile.mjs — generate and sync a Capacitor native project for the chat page (docs/spec/CHAT_PAGE.md slice 6).
//
// `cap add` scaffolds `android/` or `ios/` and refuses when the directory is already there, while `cap sync` copies
// `dist-app/` in (the standalone client, built beside `dist-web/` by build-web.mjs) and installs the native
// dependencies. Wanting "make sure it exists, then sync it" out of those two is a conditional, and a conditional
// written as `cap add || true && cap sync` in a package script parses as something else: `&&` and `||` are LEFT-ASSOCIATIVE with equal precedence, so a failing web build would be swallowed
// by the `|| true` and the sync would run on a stale bundle.
//
// NOTHING here needs Android Studio or Xcode: `cap add` writes template files and `cap sync` copies. The SDKs are
// needed to compile what this produces, which is what CI does and this machine does not.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const platform = process.argv[2];
if (platform !== "android" && platform !== "ios") {
    console.error("usage: node scripts/mobile.mjs <android|ios>");
    process.exit(2);
}

/** Run a capacitor subcommand, failing this script with its status rather than carrying on. */
const cap = (...args) => {
    const r = spawnSync("npx", ["cap", ...args], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(platform)) cap("add", platform);
else console.log(`${platform}/ is already scaffolded — syncing into it.`);
cap("sync", platform);
