# Spec: the chat page, a full-tab view over the same sessions

**Status: agreed direction, not started** (2026-09-15). Decisions below are Shane's unless marked as a proposal.

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
  starting one you choose: attach it to a tab you already have, or give it a blank tab. The agent runs as a
  background-hosted run (the loop in the service worker, DOM tools delegated to the bound tab). A third option,
  headless, is shown disabled as a placeholder: headless agents and subagents are deliberately deferred.
- **Plain chats live here too.** A conversation with no page tools needs no tab at all.
- **One index across tabs.** The overlay and the DevTools panel show one tab's sessions; this page shows every session
  from every tab, plus saved ones. The background holds the index.
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

## A first slice (proposal)

1. `chat.html`: the app in a two-pane layout, reading the background's session index; the composer continues any
   session. A new shell like `panel.ts`, and the same app→shell messages handled there.
2. Starting new chats and agents from the page, with the tab picker (and the disabled headless option).
3. Persistence: stored agent sessions, delete, the HUD toggle and its setting.
4. Resume on a new page.

## Open

- How much of a session to store: full debug events (what the log renders) or the transcript plus outputs, rebuilding
  the render from those.
- Storage limits and eviction for saved sessions with many screenshots.
- Whether the index shows ephemeral sessions from tabs that have since closed.
