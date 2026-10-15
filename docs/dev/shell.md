# The process host from the extension's side (`ml.sh`)

What `ml.sh` is and why it is shaped this way is [`docs/spec/SHELL.md`](../spec/SHELL.md). This file is how the
extension half is built. The host itself is a separate repository (window-ml-host), whose PROTOCOL.md is the
wire it speaks.

## The pieces

| File | Holds |
| --- | --- |
| `src/shell/host-protocol.ts` | the protocol client (`HostClient`): seq matching, `done` events, `{ $bytes }`, the types. No `chrome` |
| `src/shell/sh-call.ts` | pure: a call's arguments parsed, a program manifest turned into spawn args, facts into card lines and policy facts, a `done` into a result |
| `src/sw/sw-shell.ts` | the ONE native port: connect, `hello`, protocol check, `configure` from Settings, idle close, the status and the shell capabilities |
| `src/sidebar/settings/shell-section.tsx` | the Settings section "Programs (ml.sh)" |
| `tests/fake-native-host.mjs` | a host on the far end of the mocked `connectNative` (`loadBackground({ onNative })`) |

## How a session lives

- **Off until the person says so.** `shellEnabled` is false by default, and with it off or no workspace folder set,
  `connectNative` is never called: the host process is not even started.
- **One port, configured from Settings.** `shellHost()` reuses the open port while the four settings (`SHELL_KEYS`)
  are unchanged; a change closes it and the next call connects afresh. `hello` must report `HOST_PROTOCOL`, or the
  host is not used (`reason: "protocol"`).
- **Idle close after `SHELL_IDLE_MS`**, never while a call is in flight (`withShell`) or the host holds output a run
  may still read (`holdOutput`). The status survives an idle close: the host is still there to reach.
- **What dies with the worker:** the port (an MV3 eviction closes it, and the host then deletes the output it held).
  Declared as `shell.host` in the state registry.

## Capabilities

`shellCapabilities()` feeds the runtime's `RuntimeCapabilities` (sw-sessions.ts): `shellHost` when the host was
reached and configured, `shellSandboxed` when its calls run under the OS sandbox. `shellContainer` stays absent: no
container runner exists. Absent means no, as everywhere in the capabilities. The status is measured at worker start
when the setting is on, and again on every change to a shell setting.

## Who reaches the port

Only the worker, for a run's own call. `SHELL_STATUS` (the Settings page's measurement) is answered for extension pages
only: a content script's is refused before it can start the host. `tests/redteam.test.js` sends every page-started
message type from a hostile page and asserts the native port is never opened.

`nativeMessaging` is a REQUIRED permission in `manifest.json`. Chrome warns for it ("Communicate with cooperating
native applications"), so a store update asks existing installs to accept it. Making it optional, requested from the
Settings checkbox (a user gesture), is open: it has to work from both the overlay and the DevTools panel.

## Traps

- **`chrome.runtime.lastError` is the only place a native port says why it closed**, and only inside the disconnect
  listener (`nativePort`). Read later, it is gone.
- **The fake host answers synchronously enough to hide ordering bugs.** A test that depends on the port being open
  `flush()`es before asserting, as `tests/sh-host.test.mjs` does.
