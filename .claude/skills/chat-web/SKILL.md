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
npx playwright test tests/e2e/chat-web.spec.mjs  # the spec, ~2s; E2E_DIST_WEB=<dir> for a build elsewhere
```

Open a session directly with `#s=<runtime:hash>` (`#s=laptop%3A3f9a0c21` is the one waiting on an approval).

The page opens in CALM view (`src/chat/view-mode.tsx`): the brain button in the session header hands the DevTools
panel's full detail back, the `☰` hides the list pane, and both choices are stored per device, so a screenshot run
or a spec that cares about either must set or assert it rather than assume. Both are plain CSS over the same
document — nothing is removed, so a locator still finds a quieted element and `toBeHidden()` is the assertion that
means anything.

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
