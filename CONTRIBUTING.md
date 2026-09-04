# Contributing

How to get this repo running on your machine, from nothing, and how to tell that it actually worked.

This is the human-facing version. **[AGENTS.md](AGENTS.md)** is the detailed map of the codebase — the
architecture, the message contract, the conventions, and the hard-won gotchas — and is what a coding agent
reads. If you want to know *how the extension works*, go there. This file is only about setup.

If you just want to **use** the extension rather than work on it, you want
[docs/SETUP.md](docs/SETUP.md) instead; it covers pointing it at OpenWebUI or Ollama.

## 1. Prerequisites

- **Node 20 or newer.** CI runs 22, 24 and 26. `node --version` to check.
- **Google Chrome** (or any Chromium: Edge, Brave). Manifest V3, so Firefox will not load it.
- **git**.

Optional, and only for the things that need them:

- A **local LLM backend** — [OpenWebUI](https://github.com/open-webui/open-webui) or
  [Ollama](https://ollama.com). Needed to actually run an agent; not needed to build or to run the tests,
  which use a fake backend.
- **Python packages for the sandbox** — a 28MB download, see step 4.

## 2. Clone

```bash
git clone https://github.com/parawanderer/window-ml.git
cd window-ml
```

Working on more than one thing at once, or running several agent sessions? **Give each one its own
clone** as a sibling directory. AGENTS.md explains why and what to symlink; the short version is that
sharing one working tree between two workers costs more time than the disk it saves.

## 3. Install, and turn the hooks on

```bash
npm ci
git config core.hooksPath .githooks
```

**Do not skip the second line.** Git hooks are local configuration and do not come with a clone, so
without it the pre-commit checks (formatting, and regenerating `docs/spec/export.schema.json` to catch a
stale one) silently never run. Nothing appears to be wrong — commits keep succeeding — and you find out in
review.

Use `npm ci` rather than `npm install`: it installs exactly what the lockfile says.

## 4. Optional: the Python sandbox's packages

```bash
npm run fetch-pyodide     # ~28MB into pyodide-wheels/
```

Skip this and everything still builds and every test still passes. What breaks is only visible later and
does not look like a missing download: the `python_exec` tool fails at RUNTIME with
`ModuleNotFoundError: No module named 'numpy'`, which reads like a sandbox bug. The build prints a single
`⚠ pyodide-wheels/ missing` line and carries on; the real-CPython tests skip themselves.

Fetch it if you will touch `python_exec` or want the tests that exercise real pandas.

## 5. Build

```bash
npm run build      # → dist/
npm run watch      # …or rebuild on save while working
```

`dist/` is not committed. **You load `dist/`, never the repo root** — the root has no built JavaScript, and
Chrome will refuse it with `Could not load JavaScript 'content.js'`.

## 6. Load it into Chrome

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select the **`dist/`** folder.

After a `npm run build`, click the **reload** icon on the extension card to pick up the new code. A content
script change also needs the page reloaded; a service-worker change does not.

Recommended while developing: set the extension's **Site access** to **On click**, so `window.ml` only
exists on pages where you have clicked the icon.

## 7. Check that it worked

In order, so a failure tells you where you are:

| Check | Expected |
| --- | --- |
| `npm run build` | ends with `built dist/` |
| `npm test` | ~1800 tests, 0 failures |
| `npm run lint` | formatting check, then a clean `tsc` on both projects |
| `chrome://extensions` | the card loads with **no** "Errors" button |
| Any page's devtools console: `window.ml` | an object, not `undefined` |
| `await window.ml.config()` | your settings (no URL or key — those are deliberately not exposed to the page) |

`window.ml` being `undefined` almost always means the page was open before you loaded or reloaded the
extension. Reload the page.

To go further you need a backend configured (see [docs/SETUP.md](docs/SETUP.md)); then
`await window.ml.chat("hi")` should come back with text.

## 8. Tests

```bash
npm test              # the fast suite: node:test + jsdom, no browser. Run this constantly.
npm run lint          # formatting + types
npm run test:e2e      # Playwright, loads the built extension in a real Chromium. Slow, rarely needed.
npm run coverage      # writes coverage/lcov.info (the Coverage Gutters extension reads it)
```

`npm test` rebuilds first, so it always tests what you just wrote.

The e2e suite is deliberately small and separate — reach for it only when a change involves navigation, the
service-worker lifecycle, or content-script re-injection, which jsdom cannot represent. It is headless by
default and will not steal your window.

Some tests need extra things and **skip themselves** rather than failing when those are absent: the
real-CPython tests want `pyodide-wheels/` (step 4), and the live-backend tests want a `.env`. A green
`npm test` therefore does not necessarily mean everything ran — read the skip count if you care.

### Talking to a real model in tests

```bash
cp .env.example .env      # then fill in your backend URL, format, key and model
```

`OPENWEBUI_API_FORMAT` is the one worth reading the comment for: it is a property of the ENDPOINT rather
than of the server (OpenWebUI serves both wire shapes at different paths), so it has to match the URL and
cannot be guessed. Getting it wrong does not fail cleanly — an unknown route returns OpenWebUI's SPA HTML,
so the symptom is "the response was not JSON".

That enables the opt-in live tests, and lets the observation and benchmark harnesses run against your own
box (`USE_ENV=1`). Without it they use a scripted fake backend, which is what CI does.

## 9. Working on it

- **Branch and open a PR** rather than committing to `main`. CI is what catches what one change broke for
  someone else, and a local `npm test` is not that check — it does not run the e2e suite, three Node
  versions, or the real-CPython tests.
- **Read [AGENTS.md](AGENTS.md) before changing anything structural.** It is long because the surprises are
  real: which file runs in which world, why the loop lives client-side, why a privileged fetch must
  validate its own target. Most of it exists because someone got it wrong once.
- Some directories carry their own notes — `docs/spec/` for designs, `tests/e2e/bench/specs/README.md` for
  the benchmark harness.

## Troubleshooting

**`Could not load JavaScript 'content.js'`** — you selected the repo root. Select `dist/`.

**`window.ml` is `undefined`** — reload the page (the content script only injects on load), and check the
extension is enabled and has access to that site.

**`ModuleNotFoundError: No module named 'numpy'` inside `python_exec`** — you skipped step 4. Run
`npm run fetch-pyodide` and rebuild.

**Your commits are not being checked** — you skipped `git config core.hooksPath .githooks` in step 3.

**Tests hang and never exit** — usually a component left a timer running in a jsdom window. Close windows
in an `after()` hook; AGENTS.md has the detail.

**Everything is suddenly `UNMET DEPENDENCY`** — a stale `node_modules` symlink from a worktree. Delete
`node_modules` and run `npm ci`.
