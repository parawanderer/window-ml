---
name: chat-web
description: Build, serve, screenshot and script the chat page's web build (dist-web/) against the fake host, at phone and desktop width, with no extension. Use when changing anything under src/chat/, the shared session views it renders, or chat.css.
---

# The chat page on its own

The chat page (`src/chat/`, notes in `docs/dev/chat-page.md`) builds to `dist-web/` as a plain web page. Until
`HubHost` exists it opens on the fake host's demo world (`src/chat/demo-world.ts`): three runtimes (one with every
grant, one view-only, one offline) and a session in each state the page draws.

```bash
node scripts/build-web.mjs                     # dist-web/ only (npm run build does it too, after the extension)
node tests/e2e/chat-shots.mjs                  # 12 PNGs, phone + desktop, into tests/e2e/artifacts/chat/
THEME=light OUT=/tmp/shots node tests/e2e/chat-shots.mjs
SERVE=1 node tests/e2e/chat-shots.mjs          # serve dist-web/ and print the URL; open it and poke at it
                                               # <url>/client.html is the standalone client (a real hub, no fake)
npx playwright test tests/e2e/chat-web.spec.mjs  # the spec, ~2s; E2E_DIST_WEB=<dir> for a build elsewhere
```

Every view has an address (`src/chat/route.ts`): `#/s/<runtime:hash>` opens a session (`#/s/laptop%3A3f9a0c21` is
the one waiting on an approval; the old `#s=` form still works), `#/settings/<page|runtimes|devices|extension|housekeeping>`
a Settings tab, `#/search` and `#/attention` those sheets. The dev server redirects a path to its hash, so
`http://127.0.0.1:<port>/settings/devices` works too; the extension and the phone app can only use the hash form.

The page opens in CALM view (`src/chat/view-mode.tsx`), which on a wide screen has NO HEADER BAR: the title is the
transcript's first line (`.chat-lede`). With the list hidden a rail (`.chat-rail`) keeps `☰`, new session and search
at the left edge. The page's tools live in the gear's menu (`.chat-gear-btn`, bottom-left of the rail or the list):
"Calm view" (a `menuitemcheckbox`, which hands the DevTools panel's full detail back), the box, the bench and, in the
extension, Settings. Search and older sessions are one page in the main pane (`.chat-search`); Settings is a sheet of the same shape (`.chat-settings`, extension only). Both view choices are stored per device, so a screenshot run or a spec that
cares about either must set or assert it rather than assume. Both are plain CSS over the same
document — nothing is removed, so a locator still finds a quieted element and `toBeHidden()` is the assertion that
means anything.

## Its test suite

`npm run test:chat` is the chat page's suite by name: the `chat` genre of `scripts/test.mjs` (the client store, the
view prefs, the local host, and the check that the web bundle never reaches `chrome`), then `chat-web.spec.mjs` (the
web build against the fake host) and `chat-page.spec.mjs` (the extension's page against a real worker). The Playwright
half loads `dist/` and `dist-web/`, so build first, and never while another e2e run is going.

## Scripting the fake host

The web entry exposes it as `window.__chatFake` (a `FakeHost`, `src/chat/fake-host.ts`). From the page's console or a
spec's `page.evaluate`:

| Call | What the page sees |
| --- | --- |
| `__chatFake.commands` | every command the page sent, in order: assert on THIS, not on what the button looked like |
| `__chatFake.emit(key, debugEvent)` | a live event on that session |
| `__chatFake.restart(key, true)` | `reset` + backfill: the transcript is rebuilt |
| `__chatFake.restart(key, false)` | `backfilled` truncated: the transcript stays, with a note |
| `__chatFake.deleteSession(key)` | `gone` + index `remove`: back to the list, with a notice |
| `__chatFake.setRuntime(id, { online: false })` | a runtime going offline (grants and capabilities the same way) |
| `__chatFake.handlers["session.send"] = () => ({ ok: false, error: { code: "forbidden", message: "…" } })` | a refusal |
| `__chatFake.latencyMs = 800` | slow delivery, to see loading states |

## Gotchas

- **The build fails on `chrome.*` in the bundle** and says where. Route the call through `services()` or the
  `ClientPlatform`; do not guard it with `typeof chrome`, which still ships the extension path to a phone.
- **A transcript changes only when the host says so.** If an e2e step expects a change right after a click, the
  fake host has to emit it (approval, send, cancel do); a new command needs a default reply in `FakeHost.answer`.
- **Assert commands AND the transcript.** The reducer de-duplicates by `seq`, so a transcript can look right while the
  store replayed everything; `tests/chat-core.test.mjs` counts what the host re-sent for that reason.
- **The shared views run here too.** A CSS or component change in `src/sidebar/` shows up on this page, at 390px:
  re-run the screenshots, not only the panel's specs.
