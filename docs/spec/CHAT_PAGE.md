# Spec: the chat page, a full-tab view over the same sessions

**Status: agreed direction, in progress** (2026-09-15; architecture added 2026-09-17; slice 1 built 2026-09-17). Decisions below are Shane's unless marked as a proposal.

## What it is

A third surface for the one sidebar app, beside the in-page overlay and the DevTools panel: an extension page in its
own tab, laid out like a chat product (Claude.ai, Gemini). The sessions list is the left sidebar, a session's detail
view is the main body, and the composer sits at the bottom. It is another view over the same data, for a different
way of working: long-form discussion and brainstorming rather than a drawer beside a page.

Everything the app already has comes with it unchanged: themes and colours, the Python bench, the resource panel and
event lane, exports, approvals.

## Sources

The page consumes session events from two kinds of source and renders them the same way:

- **Local**: this extension's own sessions, over its own messaging.
- **Remote**: agent runtimes registered with the runtime hub ([`RUNTIME_HUB.md`](RUNTIME_HUB.md)): another
  browser, a phone-driven setup, later a headless runtime.

So the page is written against one store interface from the start: subscribe to a source's events, send it commands.
That interface is `SessionHost` ([`SESSION_CONTRACT.md`](SESSION_CONTRACT.md), `src/session-host.ts`).
Local is the first implementation; the hub transport is a second, not a rewrite. Sessions are keyed by source (a
runtime) and hash, and what the page offers for a session follows what its runtime can do.

## Decisions

- **Where a chat's agent runs.** An extension page is not a web page, so an agent chat needs a primary page. When
  starting one you choose: attach it to a tab you already have, or give it a blank tab. A "blank tab" is a new tab at a
  URL you give (prefilled from a start-page setting or the last one used), because a content script cannot run on a
  new-tab page or `about:blank` (2026-09-17). The agent runs as a
  background-hosted run (the loop in the service worker, DOM tools delegated to the bound tab). A third option,
  headless, is shown disabled as a placeholder: headless agents and subagents are deliberately deferred.
- **Plain chats live here too.** A conversation with no page tools needs no tab at all.
- **One index across tabs.** The overlay and the DevTools panel show one tab's sessions; this page shows every session
  from every tab, plus saved ones. The background holds the index.
- **What the index captures** (2026-09-17). Always: runs the background hosts, and every session on a tab whose debug
  panel is in overlay or devtools mode. With the debug panel off, a page's own sessions (a console `ml.chat`, a page
  script's agent) are listed only when the `listPageSessions` setting is on (DevTools Settings, default off), because
  reporting them wakes every page's debug bus, which off mode otherwise keeps dormant and free.
- **Persistence.**
  - Ephemeral sessions stay a valid concept (a console `ml.agent(…)`, a page script).
  - Every session started from this page is saved (`save: true`), chats and agents alike.
  - Sessions can be deleted from this page.
  - The Commander HUD gets a per-session persist toggle, and a setting for its default, defaulting to yes. Per the
    settings rule in AGENTS.md, that setting goes in the DevTools Settings panel.
  - Agent history survives a browser restart only for a saved session. That means storing agent sessions (IndexedDB),
    not only `{ save: true }` chat histories: background runs and the DevTools replay buffer live in service-worker
    memory, which MV3 evicts.
- **Approvals are reused exactly.** Inline approval decisions are already accepted only from extension-origin senders,
  and this page is one. Nothing new to build.

## Resuming a saved session on a new page (proposal)

From the agent's side, resuming on a different page is a navigation: everything in its context describes the old
page. So it reuses the cross-page machinery rather than inventing a second one.

- **The model is told, in the transcript**: resumed on `<new url>` (was `<old url>`) after `<time>`; earlier
  references to page elements no longer hold. The log shows the same as a divider.
- **Kept**: the messages, the config, the answer text, and the captured outputs, so a `@tool:` pointer from before
  the resume still resolves. Images are capped in size.
- **Dropped, and said so**: live element references, the page's `state` object, cached fetches, custom tools a page
  script defined (functions cannot be stored; the model is told which are gone), and approval grants (consent is per
  page and is asked again).
- **The same session hash**, so it stays one conversation on every surface.
- **The picker is shared** with a new chat: choose a tab or a blank one.
- **Later**: a long session may not fit the model's context on resume; that needs compaction.

## Architecture: one core, two sources, two places (proposal)

The page is one UI that runs in two places and reads from two kinds of source. Each difference is behind an interface
chosen at startup, so the core never branches on where it is.

```
              ┌──────────────────── the chat core (src/chat/, no chrome.*) ────────────────────┐
              │  layout · session list · detail view · composer · approvals · client store      │
              └────────────┬───────────────────────────────────────────────┬───────────────────┘
                   SessionHost (the contract)                     ClientPlatform (device-local)
             ┌─────────────┼──────────────┐                    ┌───────────┴───────────┐
        LocalHost     CompositeHost     HubHost           extension adapter      web adapter
     (extension port) (merges hosts)  (relay client)
```

### Two sources: every source is a `SessionHost`

- **`LocalHost`** talks to this extension's background worker over a dedicated `chrome.runtime` port. The background
  holds the cross-tab session index and each session's event ring, with the epoch and cursor the contract asks for.
  It never goes through a page: a page's main world is hostile, and the page may be closed.
- **`HubHost`** talks to the relay. Signing and encryption sit beneath its `send`, so the UI never sees them. It is a
  thin adapter over the hub's own client library (transport, pairing, keys), which the hub session owns because it
  must match the server exactly.
- **The UI takes exactly one host.** To show local sessions and hub runtimes on one page it takes a **`CompositeHost`**,
  which is itself a `SessionHost` over several:
  - `runtimes()` concatenates the hosts' lists; `status()` stays per host, so the page can say the hub is offline
    while local sessions keep working.
  - `sessions()` forwards: the contract sends one index snapshot per runtime, so merging needs no reconciliation.
  - `events()` and `send()` are routed to the host that owns the session's or command's `runtime`.
  - **The same browser seen twice** (locally, and through the hub once it is paired): when two hosts report the same
    runtime id, the composite uses the direct path (the local host) and hides the other. This needs the local host to
    report the extension's key-derived id once it has a key, as the contract says; until then the extension page does
    not also connect to the hub.
- **Below the hosts, one path**: one client store keyed by `runtime:hash`, the one existing reducer
  (`debug-reducer.ts`), timestamps corrected by each runtime's `clockOffsetMs` on the way in (zero for local), and the
  untrusted-input rules applied to local events too, so no code forks on "it is local".

### Two places: a portable core and platform adapters

- **The core (`src/chat/`) references no `chrome.*`.** It holds the layout, the session list, the detail view, the
  composer and approvals, and reuses the existing renderers (agent detail, output cells, code, tables). The build fails
  if the web bundle references `chrome`, so the rule cannot erode. Shared renderers that still call `chrome.*` today
  (session titles and block summaries, sheet titles, host-permission checks, prefs) are routed through the host
  (`side.call`) or the platform.
- **`ClientPlatform`** holds what belongs to the device, not the runtime, which is why the contract leaves it out:
  - prefs and theme storage (`chrome.storage.local`, or IndexedDB on the web);
  - downloads and exports (a file download, or the share sheet on a phone);
  - clipboard, and the image lightbox;
  - asset URLs (the CodeMirror bundle and KaTeX fonts are found with `chrome.runtime.getURL` today);
  - notifications (Chrome notifications, or web push).
- **Two entry points:**

  | | Extension page (`chat.html`) | Standalone app (`dist-web/`) |
  | --- | --- | --- |
  | Host | `LocalHost` (a `CompositeHost` with `HubHost` later) | `HubHost` |
  | Platform | extension adapter | web adapter |
  | Panels | the bench, the resource panel, Settings, highlight on the page | none, unless a capability offers one |

- **Extension-only panels register into slots.** The core shows a slot only when the runtime's capability says so and
  the entry point registered a panel for it. The resource panel could become portable later, fed by the hub's box
  telemetry.

### The phone app

The UI is built in this repository (it lives here) into `dist-web/`, a portable bundle with no `chrome.*`. **The hub
does not serve it.** The hub is only a relay, and it must stay one: its security rests on a compromised hub being able
to read and forge nothing, and whoever serves the app's code controls the keys that code holds. An app loaded from the
relay could be replaced by one that reads the device's key or signs commands itself. So the app's code reaches the
phone by a route the hub has no part in, and it connects to the hub only as a client.

**Packaged as a native app with Capacitor** (decided 2026-09-17). Capacitor wraps the `dist-web/` build in native iOS
and Android projects, and the same build still runs in a browser, as a plain page or a PWA:

- **The native app is the real client.** Its code is the package you build and sign (an update is an install), keys
  live in the platform keystore (iOS Keychain, Android Keystore, through a secure-storage plugin), approvals reach a
  sleeping phone by APNs / FCM push, and pairing scans the QR code with the camera.
- **The browser build is for development and testing**: the same core against a `FakeHost`, at phone width, with no
  toolchain. Its keys are WebCrypto keys in IndexedDB and its code comes from wherever it is served, so it is not paired
  with `approve` or `control` grants on a runtime that matters.
- **`ClientPlatform` has a Capacitor adapter** beside the web adapter: storage and keys, push, the camera, share and
  downloads. The core does not know which one it has.
- The cost is a mobile toolchain (Xcode and Android Studio) and signing (an Apple developer account for iOS).

Either way the push carries nothing but "an approval is waiting" ([`RUNTIME_HUB.md`](RUNTIME_HUB.md)); the decision is
made in the app, signed, over the relay.

- **Touch**, handled in the core rather than as a phone fork:
  - the layout collapses from two panes to one below a width breakpoint (the list, then a session), with open approvals
    badged in the list and pinned at the top of a session;
  - hover-only affordances get a tap equivalent: the panel's tooltips (`cursorTipOn`) are pointer-only today;
  - touch targets have a minimum size, and the composer stays above the on-screen keyboard.

What it takes, in order: the web entry and web adapter with a `FakeHost` (buildable now); the Capacitor projects and
its adapter; then pairing and `HubHost`, once the hub's client library exists.

### Testing both places

The same Playwright specs run the core against a scripted **`FakeHost`** twice: inside the extension page, and as a plain
page with no extension loaded at a 390 px viewport, which also proves the web bundle needs no `chrome`. The fake host
stands in for the hub until the relay exists, and a narrated demo on it doubles as the live mockup of both layouts.

## Pairing and grants: the UI's side (proposal)

How a client comes to be allowed to use a runtime, as the screens see it. The protocol, the keys and the account model
belong to the hub ([`RUNTIME_HUB.md`](RUNTIME_HUB.md) §Security, where the pairing flow is still open); this is what
the UI needs from them.

**Pairing is not part of the chat page.** Its screens are standalone components with no dependency on the chat core's
layout or store, rendered by whichever surface wants them:

- **Runtime side** (show a pairing offer, confirm a request, the paired-devices list): rendered in the DevTools panel,
  the in-page sidebar and the chat page (through the Settings they share, or directly), and in the **Commander HUD**,
  which is where a person already answers approvals on the page they are looking at, so a device asking to pair can be
  confirmed there without opening anything else. Also reachable from the toolbar popup.
- **Device side** (scan an offer, show the comparison code, the runtimes this device is paired with): the phone app,
  and the extension page when this browser pairs itself as a client of another runtime.
- **The components take their dependencies as props**: the hub client library's pairing API, and the host's
  `ClientPlatform` for storage and QR scanning (a camera on a phone, a pasted code on a desktop). So any surface that
  can supply those can render them, and none is the one place pairing happens.

**Pairing a device, done in person at the runtime:**

1. On the runtime, **Pair a device** (in Settings on any extension surface, or wherever else it is offered) shows a QR code. It holds the hub's address, the
   runtime's public key, a one-time pairing secret, and an expiry of a couple of minutes.
2. The phone app scans it (or the person types a short code), creates its own key, connects to the hub, and sends a
   pairing request to the runtime, proven with the secret.
3. **Both screens show the same comparison code**, derived from both keys and the secret. The person checks they match
   and confirms **on the runtime**. A relay that swapped keys in between would produce different codes.
4. **Scopes are chosen on the runtime at that moment, never by the device asking.** `view` and `drive` are the
   default. `approve`, `screen` and `control` are opt-in, each with a line saying what it allows, plus an optional
   expiry.

**Granting another client:**

- **At the runtime**, the same flow for each new device, and a **Paired devices** list: name, kind, scopes, last seen,
  who granted it. Scopes can be edited and a device revoked there; a revocation takes effect at the runtime's allowlist
  at once, and every client sees it as a change to its `grants`.
- **From a device, by delegation**: a device may pass on a narrowed grant (a subset of its own scopes, to certain
  sessions or `started` ones, until an expiry) to another key, such as a colleague's phone or an orchestrator agent.
  The runtime checks the chain on every command. **`approve` and `control` cannot be passed on this way**; they are
  granted only at the runtime. A delegated grant appears in the runtime's list as granted by its device, and revoking
  a device revokes what it passed on.
- **Agent clients** get their grants at spawn ([`RUNTIME_HUB.md`](RUNTIME_HUB.md) §Principals and scopes) and show in
  the same list.

**The paired-devices list** renders `device.list` ([`SESSION_CONTRACT.md`](SESSION_CONTRACT.md) §Devices), and four
of its rules are about what a row must be able to say rather than about what it shows:

- **"This device"** on the row whose `principal` matches the one this client computes from its own key. A list of
  five phones where one of them is the one in your hand is otherwise a guessing game.
- **Revoking that row logs you out**, said before it happens rather than discovered when the page stops working. It
  is the only destructive action here whose consequence is invisible from its label.
- **"Expires in N days"** while a device is valid, and **"expired, pair it again"** with no button after, because a
  lapsed device cannot authenticate to ask for a renewal.
- **"Revoked; this runtime's keys rotate when it is next online"** while `rotation` says something is still owed. A
  revocation that left the stream readable and said nothing would be the one lie the page tells.
- **"Can pair other devices"** on a row whose `mayPair` is set. It is not one of its scopes and cannot be read off
  them: such a device can issue a certificate for a new one by itself, without `admin` and without asking the
  runtime, which is a different and larger thing than driving a run.

`lastSeenMs` is rendered prominently rather than as metadata: a runtime renews the devices on its allowlist itself,
so a forgotten device does not expire on its own, and this is the only thing that surfaces one. Times come from the
runtime's clock, so the list renders the time and not the arithmetic.

**While it is in use**, the runtime's own sidebar says who is watching or controlling it, with a way to stop them.

**What the UI needs from the hub's client library** (not `SessionHost`, which leaves pairing to the transport):
creating a pairing offer and accepting one, the comparison code, listing paired principals with their grants, editing
and revoking, and delegating a grant. The screens are the UI's; the cryptography is the hub's.

## Remote control from a phone (proposal)

Driving an agent from a phone needs to see the agent's page and, at times, act on it directly: dismiss a dialog the agent
is stuck on, or sign in where it cannot. Three things, each a contract addition proposed in
[`SESSION_CONTRACT.md` §Proposed: remote control](SESSION_CONTRACT.md):

1. **A one-off screenshot** exists already: `tab.screenshot` (scope `screen`, capability `screenshots`). The addition is
   a target for a desktop runtime's display.
2. **Input at a point**, a new command: a click (and move, scroll, text and keys) at coordinates in the frame the client
   is looking at. The runtime maps them to the viewport and refuses a stale frame. It uses the trusted CDP input the
   agent's own clicks already use (`cdpClick`), whose debugger banner is the visible signal that the page is being
   driven. It needs its own scope, because acting as the user in a logged-in browser is more than `drive`, and it is
   recorded in the session so the agent knows the page changed under it.
3. **Streaming the display**, still open: a subscription rather than a command. The first version would send screencast
   frames over the relay; real video is a later option with a different security story.

The phone's side of it lives in the core: a viewer that shows the latest frame with its age, maps a tap to the frame's
coordinates, and offers live viewing only when the runtime has the capability.

## Slices (proposal)

1. **The core against a fake host**: `src/chat/` with the client store keyed by `runtime:hash`, both layouts,
   `CompositeHost`, `FakeHost`, `ClientPlatform` with both adapters, both entry points, and the `chrome`-free build check.
   **Done except the extension's entry and adapter**, which need a host to point at and come with slice 3: the services
   seam (#110), then the store, the hosts, the web adapter, both layouts and the web build with its check. How it is
   built: `docs/dev/chat-page.md`.
2. **Background plumbing for the local host**: the cross-tab session index, per-session event rings with epoch and
   cursor, `tabs.list`, starting an agent on a chosen or blank tab from an extension page, delete.
   **Done**: the index, the rings, the `ml-sessions` port, `LocalHost`, the capture setting, the commands on
   existing sessions, `chat.start` and `agent.start` (`docs/dev/chat-page.md` §The local index, §The local
   commands, §Chats the worker hosts, §Starting a run from an extension page). What a saved session means, and
   what survives an evicted worker, is slice 4.
3. **`LocalHost`**: `chat.html` over slice 2, with the extension's `ClientPlatform`. (`LocalHost` itself, `side.call`,
   `page.highlight` and screenshots landed with slice 2.) The local host then works end to end.
   **Done**: the extension entry and its adapter, the popup's way in, and starting a chat or an agent run from the
   list header (`docs/dev/chat-page.md` §The extension entry, §Starting a session from the page).
4. **Persistence**: saved agent sessions (IndexedDB), the Commander persist toggle and its Settings default, delete.
5. **Resume on a new page.**
6. **The phone app**: the Capacitor projects and their `ClientPlatform` adapter (never served by the hub), then
   `HubHost` over the hub's client library.
7. **Pairing components**, standalone and usable from any surface, over the hub's client library: pair a device, the
   paired devices list, delegation.
8. **Remote control**: the viewer, input at a point, then streaming, once the contract additions are agreed.

## Open

- How much of a session to store: full debug events (what the log renders) or the transcript plus outputs, rebuilding
  the render from those.
- Storage limits and eviction for saved sessions with many screenshots.
- Whether the index shows ephemeral sessions from tabs that have since closed. For now it does, as `interrupted` when
  they were still running, until the index's caps or the worker's eviction forget them.
