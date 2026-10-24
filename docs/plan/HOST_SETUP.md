# Brief: setting up the process host from the extension

Asked by Shane, 2026-10-23, beside [`HUB_SETUP.md`](HUB_SETUP.md). PARKED under the 2026-10-23 freeze
([`repl/README.md`](repl/README.md), Status); assigned when the usage week resets. Coordinator: `repl-specs`. Reviewer:
the janitor (`window-ml-flaky-ci`). A red-team pass only if a page-started message type is added, which this brief
expects not to happen: `SHELL_STATUS` is answered for extension pages only and stays so.

## The ask

A person who wants `ml.sh` should get the host onto their machine and attached to this browser without building Rust
or reading `src/`: a doc in the repo, then a flow in the extension that walks them through it and tells them, at each
step, what is true. Once set up, the host is the "Programs (ml.sh)" entry in the DevTools Settings list, which the chat
UI's settings page shows too (Shane, same day, for the hub; the same rule here).

## What exists (verified 2026-10-23)

| Piece | State |
| --- | --- |
| The host ([window-ml-host](https://github.com/parawanderer/window-ml-host), v0.5.0): `wmlhost install --extension-id <id>` writes the native messaging manifest naming the binary and allowing only that extension; `uninstall` removes it | BUILT; install is a terminal command after `cargo build --release` |
| The extension's side (`src/sw/sw-shell.ts`): the one port, `hello` and the protocol check, `configure` from Settings, a status with a reason (`off`, `no-roots`, `not-installed`, `protocol`, `config`) | BUILT |
| Settings "Programs (ml.sh)" (`src/sidebar/settings/shell-section.tsx`): the note with the install command carrying THIS browser's extension id, the enable checkbox, the workspace roots, a status line with the reason | BUILT; this is already a front door |
| A release of the host (a binary to download) | NONE: `gh release list` on the host repo is empty; the only path is `cargo build` |
| The doc in window-ml | NONE: `docs/FULL-SETUP.md` and `docs/SETUP.md` do not mention the host or `ml.sh`; `docs/dev/shell.md` is for someone changing the code |
| The host's README | says "The extension does not use the host yet", stale since lane 4 and the `ml` wire |

So, unlike the hub, the extension already tells the person what to run and whether it worked. What is missing is a
binary they can get without a Rust toolchain, a doc that starts from nothing, and the steps between "not installed"
and "ready" being walked rather than listed.

## What to build

1. **A release of the host.** A tagged release on window-ml-host with a binary per platform (macOS arm64 and x64,
   Linux x64), built by its CI, with the sha256 beside each. The host repo's own work; its README's stale line goes
   with it. Until a release exists nothing below is honest, so it is first.
2. **The doc** (`docs/FULL-SETUP.md`, a new section before the hub's, or a `docs/<SHELL>.md` it links): what `ml.sh`
   gives in one paragraph, download the release for your platform (or build it), run `wmlhost install` with the id the
   Settings page shows, turn it on, add a workspace folder, run `ml.sh.run(["git","status"])` from the console and see
   the card. The sandbox in one paragraph each for macOS and Linux (what is enforced, what asks). Every command copied
   from a run that worked, with the output it printed.
3. **The Settings section walks instead of lists.** The same section, reordered by state, never showing a step whose
   precondition is unmet: `not-installed` → the download link for this platform and the install command with the id,
   and a "check again" that re-measures; `protocol` → which version answered and which this build needs, with the
   release to get; `off` → the checkbox; `no-roots` → the folder picker; `ready` → where calls run (sandboxed or not)
   and the one-line example to try. The reasons already exist; the section stops showing the whole form at once.
4. **The popup gets one line** ("Programs: not installed / ready"), linking to the Settings section. The DevTools
   Settings panel stays the superset (AGENTS.md).
5. **The `nativeMessaging` permission question** (`docs/dev/shell.md`, "Who reaches the port"): it is required today
   and Chrome warns on update. Making it optional and requested from the enable checkbox is open because it needs a
   user gesture from both the overlay and the DevTools panel. Decide it in this work, measured on both surfaces, or
   write down why it stays required.

## Properties that do not move

- The host never listens; Chrome starts it over stdio and the manifest's `allowed_origins` is the whole trust
  (`docs/spec/SHELL.md`, "Security invariants"). No pairing code, no token, no discovery over the network.
- Only the worker opens the port, for a run's own call; `SHELL_STATUS` stays extension-pages-only and
  `tests/redteam.test.js` keeps asserting a hostile page never opens the port.
- Off by default; with it off or with no workspace folder the host process is never started.
- `shellEnabled` and the other `SHELL_KEYS` remain the one configuration; the setup flow writes those keys and no
  others, and anything new it keeps goes through `defineState`.
- A hub is not an execution environment: the setup says nothing about the hub, and the host's `hub` feature stays off
  in the release build.

## Acceptance

- A person with no Rust toolchain, following the doc and the Settings section on macOS, reaches `ready` and sees one
  `ml.sh` card in one sitting; the builder does it once on a clean user account and writes what took longest.
- Each state's rendering has a gallery entry and a test that the step for an unmet precondition is not shown.
- The release's sha256 is what the doc prints, and `wmlhost --version` after install matches the tag.
- `docs/FULL-SETUP.md` names the host; the host README no longer says the extension does not use it.

Labels `@exec,@ui,@docs`; the release work carries the host repo's own labels. Size: M, the release being S on its own.
Questions to `repl-specs` by session-mail; state the assumption in the PR rather than block.
