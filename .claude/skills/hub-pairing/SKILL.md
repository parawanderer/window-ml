---
name: hub-pairing
description: Pair this browser with a REAL window-ml hub before the pairing screens exist, using the command-line root device (scripts/hub-root.mjs) and the extension's development page (dev-hub-pair.html), then read how the runtime connection fared. Use for a live hub test (the one on mlbox over the tailnet), for checking an MV3 worker stays connected while idle, or for pairing anything (a box connector) to a test account.
---

# Pairing against a real hub

Two stand-ins for screens that do not exist yet, both running the calls the screens will (`src/hub/pair-flow.ts`):

- **`scripts/hub-root.mjs`**: the account's ROOT DEVICE on the command line. It creates the account and confirms the
  codes other devices show.
- **`dev-hub-pair.html`** (in the built extension): offers THIS browser as a runtime, shows the code and fingerprint,
  and afterwards shows the worker's connection state, its device list and its connection history.

## Pair a browser, start to finish

```bash
# 1. once: create the account (a fresh hub is invite-only; the operator runs `wmlhub invite create`)
node --import tsx scripts/hub-root.mjs create wss://gpubox.tadpole-morray.ts.net:8787 --invite wmlhub-invite-… --label "laptop CLI"

# 2. in the browser: open chrome-extension://<id>/dev-hub-pair.html, enter the same URL, "Offer this browser".
#    It shows a code like "PY1W 365B" and a fingerprint.

# 3. confirm it here; the fingerprint printed must match the page's, and you type yes
node --import tsx scripts/hub-root.mjs confirm "PY1W 365B"

node --import tsx scripts/hub-root.mjs show     # hub, account id, account root, this device
```

The page says "Paired", tells the worker (`HUB_RUNTIME` `paired`), and Refresh shows `"state":"online"`.

`wmlbox pair --hub <url> --label … --state-dir …` offers a box connector the same way, and `confirm` answers it.

## The idle test

Close `dev-hub-pair.html` first: an open extension page messaging the worker keeps the worker alive, which is the
thing under test. The page never polls, for the same reason. Leave the browser alone, then reopen the page and press
Refresh: **history** lists every `start`, `connecting`, `online (n devices)` and `offline: <reason>` with its time,
kept in `chrome.storage.local` (`ml_hub_log`, last 200), so it outlives the worker. A `start` with no `offline` before
it means the worker was stopped and the one-minute alarm started it again. Compare with the hub's side
(`docker compose logs hub` on mlbox): a close the hub saw versus a connection it simply stopped hearing from.

## Gotchas

- **The state file IS the account, root key included, in the clear** (`~/.config/window-ml/hub-root.json`, mode
  0600; `--state <file>` for another). A real device keeps keys non-extractable; this is a test tool, so treat an
  account made with it as disposable. Delete the file to forget it; the hub keeps the account until its operator
  removes it.
- **`create` twice refuses** ("already belongs to an account"). Use another `--state` for a second account.
- **An invite works once.** A second `create` against the same hub needs a new one.
- **`wmlbox` prints the account ROOT as "Account"**; `show` prints both the account id (a hash of the root) and the
  root, so they can be compared.
- **Leave the account** on the page (it keeps the browser's keys, so pairing again is the same principal) before
  pairing the same browser to another account.
- **Remove this page** once Settings has the pairing screens; nothing else links to it.
