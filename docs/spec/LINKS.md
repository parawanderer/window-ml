# Spec (proposed): links to a setting or a chat page view

**Status: proposed 2026-11-13; slice 1 built 2026-11-13** (the panel's addresses in the sidebar and the DevTools
panel: the place table, `data-setting` rows, the renderer, `openAddress`; `docs/dev/sidebar.md`, "Links to a setting
in model text"); the HUD card's links, through the worker, the same day. Not built: session, search and attention addresses, the chat page's surfaces and the exports' text.
From Shane's words in the calm-chat-motion session (2026-11-13), handed to the settings-specs lane by the
policies/python/desktop/manifests coordinator. Ruled by the coordinator on
2026-11-13, pending Shane: a spec of its own, one parser for hashes and links, a button and never an `<a href>`, and
an address in the grammar for the DevTools panel's tabs with no URL of its own; the rest is open. A companion to
docs/spec/MODEL_SETTINGS.md (proposed in #1793, the same lane), which a link does not depend on.

Shane: "being able to provide the user with a clickable link to a setting or to the Chat UI page, since those have a
canonical URL."

**Why a spec of its own, not a section of [`CHAT_PAGE.md`](CHAT_PAGE.md).** A link is written by the model once and
drawn on every surface a transcript is drawn on: the overlay sidebar, the DevTools panel, the chat page in the
extension, the chat page's web and phone builds, and the exports. The chat page's routes are one of its inputs, and the
changes to them proposed here are the chat-page lane's to make (`src/chat/route.ts`, "Owners" below).

## What exists today

- **The chat page has hash routes**, parsed and written in `src/chat/route.ts`: `#/s/<runtime:hash>`, `#/search`,
  `#/attention`, `#/settings`, `#/settings/<tab>` for the tabs `page | runtimes | devices | extension |
  housekeeping`, and one anchor, `#/settings/extension/backup` (`src/chat/settings-page.tsx`). Anything the parser does
  not know opens the list, never an error. The popup's `openChat(hash)` (`src/popup.ts`) opens or focuses the page at
  a hash.
- **The DevTools Settings panel has no address.** Its view is an in-memory signal (`view` in `src/sidebar/store.ts`),
  its tabs (`connection | models | appearance | advanced | permissions`, `SETTINGS_TABS` in
  `src/sidebar/settings/settings.tsx`) and collapsible sections (`Section({ id })`, ids unique across tabs) are
  signals too; nothing in `src/sidebar/` reads or writes `location.hash`. What it has is
  `showSettingsSection(tab, section, targetId?)`, which the chat page's `backup` anchor calls.
- **No setting row has an address.** No control in the panel has a DOM id; the one scroll target is the Backup block
  (`set-backup`, `BACKUP_BLOCK_ID`).
- **A "find this setting" service already exists on every surface**: `services().findSetting(query)`
  (`src/sidebar/services.ts`), implemented for the sidebar and the DevTools panel (`src/sidebar/services-ext.ts`:
  Settings, filtered by the query) and for the chat page (`src/chat-ext.tsx`: Settings → Extension, filtered, and
  through `ChatExtras.findSetting(runtime, query)` for a named runtime). The spend chip and the attention list use it.
- **The transcript links only `http(s)` destinations.** `markdown()` (`src/sidebar/format.ts`) turns
  `[text](https://…)` into a link with its destination as the tip, and leaves every other destination as text. A
  `chrome-extension://<id>/chat.html#/…` link would show as text, and the model cannot know the install's id anyway.
- **The model's in-run link form already exists for pointers**: `[label](@tool:<id>)` becomes a button that goes to the
  step (`src/sidebar/transcript/prose.tsx`, `splitProse`), and an unresolved one renders as its label.

## The rule

1. **A link opens a view for the person. It never acts.** The grammar has no verb: no address starts, resumes, steers
   or cancels a run, changes a setting, answers a card, or fills in a field. There are no query parameters.
2. **A link never targets a run on a page we own** (AGENTS.md: "A run never starts on a page WE own"). Opening a
   session's view shows its transcript; it does not resume the session, and sending from there is the person's act on
   that view, as it is today.
3. **The model writes one form, and the surface resolves it.** The model never writes a `chrome-extension://` URL, an
   extension id or a hash of its own surface.
4. **A link is never an `<a href>`.** It renders as a button that calls the surface's service, so no destination a
   model or a page wrote reaches the browser as a navigation.

## The form the model writes

A Markdown link whose destination starts `window-ml:`, followed by an address:

```text
[Backup and restore](window-ml:settings/extension/backup)
[Programs (ml.sh)](window-ml:settings/extension/advanced/shell)
[Auto-approve read-only surveys](window-ml:setting/autoApproveReadonly)
[this session in the chat page](window-ml:s/local:3fa91c2e)
[the search page](window-ml:search)
```

`window-ml:` is a marker, not a URL scheme: nothing registers it, and the renderer is the only thing that reads it. It
is told apart from an `@tool:` pointer by shape, as the pointer forms are from each other (`docs/dev/pointers.md`).

## Addresses

| Address | Opens | Today |
| --- | --- | --- |
| `s/<runtime:hash>` | the session's view | the chat page's `#/s/…` |
| `search`, `attention` | the search page, the attention list | the chat page's routes |
| `settings` | Settings | `#/settings` |
| `settings/<tab>` | a tab of the chat page's Settings (`page`, `runtimes`, `devices`, `extension`, `housekeeping`) | `#/settings/<tab>` |
| `settings/extension/backup` | Backup and restore | the one anchor |
| `settings/extension/<panelTab>` | a tab of the extension's settings view (`connection`, `models`, `appearance`, `advanced`, `permissions`) | parsed (`route.ts`) |
| `settings/extension/<panelTab>/<section>` | that tab with the section open and scrolled to (`advanced/shell`, `permissions/policies`) | parsed (`route.ts`, from `PANEL_LAYOUT`); `showSettingsSection` exists |
| `setting/<key>` | the row of one setting, by its config key: its tab, its section open, the row scrolled to and marked | parsed (`route.ts`), a key with a row (`SETTING_PLACES`) |

The address grammar is the chat page's, minus the leading `#/`, plus the two new forms. One parser serves both:
`parseRoute` grows the panel tab and section, and a `window-ml:` destination is parsed by the same function, so a hash
and a link cannot disagree about what an address means. `backup` stays an alias of `appearance/storage` with the
Backup block as its target, so the existing link keeps working; no panel tab is named `backup`, so the third part is
unambiguous.

**The DevTools panel's tabs get an address in the grammar, not a URL of the panel's own** (the coordinator's "may need
an address", answered as a proposal). The panel's URL is never seen by the person and is not something they can
bookmark or share; what a link needs is a name the renderer can resolve, which the grammar gives. On the chat page in
the extension the same address is also a real hash (`#/settings/extension/advanced/shell`), because the chat page's
Extension tab draws the same settings view.

**A setting's address is its config key**, the name the model already reads (`ml.settings()` in
MODEL_SETTINGS.md, #1793, or `ml.config()`). To resolve it, each row of the panel carries
`data-setting="<key>"`, and a table beside `DEFAULT_CONFIG` names each key's tab and section. A test enumerates
`DEFAULT_CONFIG` and fails on a key with a panel control and no place, or a place whose row does not carry the key
(AGENTS.md: enumerate, do not sample). A key with no control (today `ocrNumCtx`) has no place, so no address, and
its link renders as text: the parser accepts exactly the keys with a place (`SETTING_PLACES`). A link to a secret's
row (`setting/apiKey`) is allowed: it opens the row, never reads the value, and "set your API key here" is exactly the
help Shane asked for.

## What a click does, by surface

Each surface implements one new service, `services().openAddress(route)`, beside `findSetting`; the transcript code
calls only the service (the sidebar trap: session views call `services()`, never `chrome.*`).

| Surface | A settings address | A session, search or attention address |
| --- | --- | --- |
| Overlay sidebar, DevTools panel | the panel's own Settings view, through `showSettingsSection`; a setting's row scrolled to and marked | opens the chat page, or focuses it where it is open, at the hash: the popup's `openChat`, moved to where the sidebar can call it through the worker (an extension-page message, never in `HANDLE_MAP`) |
| HUD card (the Commander's) | opens the chat page, or focuses it, at the address's hash (Shane, 2026-11-13: the chat page's Settings, not the sidebar), through the worker's `OPEN_CHAT_PAGE` | the same |
| Chat page, in the extension | the hash, set in place; the page reads it on `hashchange` as today | the hash, in place |
| Chat page, web and phone builds | the session's runtime's settings, through `ChatExtras.findSetting`'s runtime argument, where that runtime reports `localSettings` and this device can draw them; otherwise the link renders as text with a tip naming where it lives | the hash, in place |
| Exports (Markdown, PDF, JSON) | text: the label and where it is (`Backup and restore (Settings → Storage)`); the raw link in the raw view | text: the label |

A setting link in a session belongs to the RUNTIME the session runs on: on a phone, `setting/cdp` in a session of the
browser at home names that browser's setting, not the phone's. A device that cannot draw that runtime's settings
renders it as text.

**An address that does not resolve renders as its label**, plainly, as an unresolved `@tool:` pointer does: the model
naming a section that is not there is shown as what it wrote, not as a link to the list. (A typed or old HASH still
opens the list, as today; the difference is that a hash is a place the person went to, a link is a claim the model
made.)

**The tip says where it goes**, from the resolved address, never from the label: `Opens Settings → Advanced → Programs
(ml.sh)`, `Opens this session in the chat page`. Link text and destination are the two things Markdown lets disagree
(`linkTip`'s reason), and here the destination is a view, so the tip names the view.

## How the model learns the form

Not in the system prompt: every token there is paid on every turn (`docs/spec/PROMPT_BUDGET.md`). The `agent_api_docs`
tool gets a `links` topic: the form, the address table, and one line per setting key with its label and place,
generated from the table the class test checks. Whether one sentence in the prompt ("you may link to a setting as
`[label](window-ml:setting/<key>)`") earns its cost is open question 1, for the next prompt review
(`docs/dev/prompt-review.md`).

## Threat model

Who writes the link is the model, and what the model writes can come from a page it read. What a link can do is open a
view; so the questions are what opening can cost, and whether the form leaks into anything that acts.

1. **A page making the model link somewhere.** The worst a link does is open Settings at a section or a session's view:
   it changes nothing, and the tip names the place. A link to Permissions → "Sites that approve their own actions" is
   a social-engineering aid, no more than the model's own text saying "go to Settings → Permissions" is today. A link
   to the API key's row (`setting/apiKey`) is the same aid as the text "paste your key in Settings" and no more: the
   row shows the person a field and reads nothing back to the model.
2. **A link that acts.** Ruled out by the grammar (rule 1): the parser accepts only the addresses above and returns a
   `Route`, which has no field that acts.
3. **A destination reaching the browser.** A `window-ml:` link is a button, never an `<a href>` (rule 4); a destination
   that is not `http(s)` or `window-ml:` stays text, as today (`javascript:`, `data:`, `chrome-extension:`,
   `chrome:`).
4. **A page using the form itself.** A link is drawn only in the extension's own transcript views, from the model's
   text; a page's DOM never gets one. The extension-page message the HUD card uses to open the chat page
   (`OPEN_CHAT_PAGE`) is not page-started and is not in `HANDLE_MAP`, and the worker refuses it from anything but an
   extension page, so a page cannot open the chat page or Settings through it. Its URL is `chat.html` and the hash of
   an address a link resolves, never one the sender sends.
   The reverse holds too: page text enters the transcript through tool results (a fetched page, a DOM read, a Python
   `print`) and through the model quoting it, so **a `window-ml:` link is resolved only in the model's own prose**. In
   a tool result, an output cell, a quoted block, a code span or fence, or anything else that came from a tool or a
   page, it stays text. The renderer that draws tool output never calls the link resolver; only `Prose`, over the
   model's reply, does, and a `>` quote inside that reply is text too.
5. **Another session's view.** `s/<runtime:hash>` opens only a session the viewing surface already lists; one it does
   not renders as text. The link reveals nothing the model did not already write. The address keeps the key whole,
   as `parseRoute` does today, and whatever splits it into runtime and hash splits on the LAST `:` (AGENTS.md, the
   sidebar trap), since a runtime id may itself contain one.

**Red-team rows**: a `window-ml:` destination
yielding an `<a href>` anywhere in the transcript, the sidebar, the chat page or an export; any address with a query or
a fragment parsing to anything but text; a page reaching the open-the-chat-page message; an address starting,
resuming or sending in a session; a tool result, an output cell or a quote containing `[x](window-ml:setting/apiKey)`
rendering as anything but text. Ruled by the coordinator (pending Shane): no separate red-team pass for this spec,
since a link adds no agent tool, no `ml.*` member and no page-started message. These rows are the builder's
checklist, landing in the builder's PR as its own file (rule 10).

## Tests

- `parseRoute` over every address in the table, each round-tripping through `formatRoute`; the alias `backup`; an
  unknown tab, section or key returning nothing a link resolves; `s/<runtime:hash>` with a runtime id that itself
  contains a colon (`hub:box-2:3fa91c2e` names runtime `hub:box-2`, hash `3fa91c2e`).
- The setting-place table against `DEFAULT_CONFIG` (above).
- The renderer: a `window-ml:` destination is a button with the resolved tip; an unresolved one is its label; every
  other non-`http(s)` destination is text.
- **The upgrade**: a transcript written before this has no `window-ml:` links, so nothing changes for it; a transcript
  with one, read by an older build, shows the literal `[label](window-ml:…)` as text, which is what an old build does
  with any destination it does not know. A fixture of each.

## Open questions

1. A sentence in the system prompt, or `agent_api_docs` only (above).
2. Whether the chat page's web and phone builds should offer "open on that browser" for a setting of a runtime they
   cannot draw, through the hub; out of scope here.
3. Whether a step of a session (`s/<runtime:hash>/step/<n>`) is an address; the `@tool:` pointer already links a step
   inside the run, so the lean is no.

## Owners

`src/chat/route.ts`, the chat page's hashes and its service: the chat-page lane (calm-chat-motion), told before anyone
changes them. The panel's rows, the place table and `showSettingsSection`: the settings panel's owner. The renderer
(`prose.tsx`, `format.ts`): the sidebar's transcript owner. This text: the settings-specs lane.
