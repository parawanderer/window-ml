# Spec (proposed): settings the model can see and change

**Status: proposed 2026-11-13, nothing built.** From Shane's words in the calm-chat-motion session (2026-11-13) and the
points agreed there, handed to the settings-specs lane by the policies/python/desktop/manifests coordinator. Questions
1 to 3 of the first review (`ml.config()` stays as it is; the guarded class is not a second mechanism; the default
list) were ruled by the coordinator on 2026-11-13 as proposed, pending Shane; the rest is open. A new agent-facing
surface, so the threat model below is reviewed by the red team (e3, through the coordinator) before this lands.

Shane: "letting the model update user settings (which probably requires a whitelist of what settings the model can
even see and update. I think we have something like this already. But it's part of this whole idea that there honestly
should be no reason the model can't help the user use its own tool.)"

**Why a spec of its own.** No existing spec fits. [`POLICIES.md`](POLICIES.md) is the mechanism this uses, not a home
for one consumer's surface (the `fetch`, `sh` and `act` consumers each live with their own feature); the
[`SITE_ACCESS.md`](SITE_ACCESS.md) rules are about pages, and this surface is one a page never reaches. The nearest
precedent in shape is the files API in [`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md), "`/files` on the person's disk",
whose "deleting the person's files asks unless a policy allows it" is the rule reused here.

## What exists today

"Something like this already" is real, and it is not a whitelist the person controls:

- **`ml.config()` returns a fixed subset**, `publicConfig()` in `src/contract/contract-config.ts`: 20 keys
  (`model`, `ocrModel`, `ocrNumCtx`, `apiFormat`, `defaultModelVision`, the three utility-model keys,
  `autoApproveReadonly`, `autoApprovePython`, `autoApproveSelfSource`, `serverToolsOff`, `commanderServerTools`,
  `selfIntrospection`, `pierceClosedShadow`, `cdp`, the three grounding keys, `debugMode`) plus the computed
  `pageApprovalAllowed`. (`MlPublicConfig` also names `labelMatch`, which `publicConfig()` does not return.) It is
  the `GET_CONFIG` message (`src/background.ts`), the same view the worker hands its own run assembly (`workerMl`).
- **The model reads it free.** `config` is in `ML_READONLY_METHODS` (`src/readonly-exec/policy.ts`), so a read-only
  survey calls `ml.config()` with no card. So does any script on an approved origin.
- **The one write a page or the model has is `ml.setModel`** (`SET_MODEL`), validated against the server's model list
  (AGENTS.md: "Pages can change only the model").
- **The code already knows which settings matter**: `SECRET_KEYS` in `src/sw/sw-scrub.ts` (`chatUrl`, `apiKey`,
  `modelFilter`, `priceSnapshotUrl`) and `RISKY_CONFIG` in `src/backup/backup-settings.ts` (settings that send traffic
  or widen what runs without asking, which a restore lists apart with what each does).

That subset was chosen in code, for the page, and the page reads it too. What this spec adds is the person's own list,
for the model, with writes.

## The rule

1. **The whitelist is the person's.** It names setting keys, each `read` or `read-write`. The model reads and writes
   only keys on it; a key off it is neither readable nor writable through this surface, and the refusal for a key off
   the list reads the same as for a key that does not exist.
2. **A change asks unless a policy allows it**, through the policy store (`POLICIES.md`), as a new consumer `setting`.
   One mechanism: no second store, no per-setting "always allow" button, no remembered answer of its own. (The
   fatigue refusal under "Threat model" is run-scoped memory of the model's own refused call, not an answer: it never
   lets a change through.)
3. **A guarded change always asks**, whatever a policy says (below, "Three classes of setting"). Precedent: a
   credentialed fetch asks regardless of policy (`POLICIES.md`, "Scopes"). A policy may still DENY a guarded change.
   This is not a second mechanism: the same consumer, the same store and the same judge, and the guarded class is an
   answer the judge cannot free, as a credentialed fetch is (ruled by the coordinator, 2026-11-13, pending Shane).
4. **A page-started run never reaches it**: not the reads, not the tool, not the card (below, "Who reaches it").
5. **Secrets are never whitelistable**, and neither are the stores that decide what the model may do (the whitelist
   itself, policies, site lists).
6. **The DevTools Settings panel is the superset.** The whitelist is edited there; a setting the panel does not show is
   not a setting for this purpose.

`ml.config()` is not changed by this spec. Its 20 keys stay readable by the model and by approved pages whatever the
whitelist says, because a page on an approved origin can call it itself and the worker cannot tell the model's call
from the page's (the sender is the tab either way). Rule 1 governs the new surface; the Settings section that edits the
whitelist marks those 20 keys "readable by approved sites and the model regardless" (ruled by the coordinator,
2026-11-13, pending Shane). Narrowing an isolated-world exec's `ml.config()` to the whitelist is open question 1, a
later slice.

## Three classes of setting

Every key the panel shows is in exactly one class, declared in code beside `DEFAULT_CONFIG`. A test enumerates
`DEFAULT_CONFIG` and the panel's local display preferences and fails on a key with no class (AGENTS.md: enumerate the
inputs, do not sample them); a new setting therefore cannot land unclassified.

| Class | Whitelistable | A change | Keys (the initial classification; the code's table is the truth) |
| --- | --- | --- | --- |
| **secret** | never | impossible | `chatUrl`, `apiKey`, `modelFilter`, `priceSnapshotUrl` (exactly `SECRET_KEYS`), and the legacy `pageApprovalDomains` (it is a site list) |
| **guarded** | yes, by the person | always asks in the guarded direction; a policy may deny, never allow | what widens what runs unasked or what the model reaches; what sends traffic somewhere; what shrinks the person's record of what happened. See the next table |
| **ordinary** | yes | asks unless a policy allows it | everything else: models and their context sizes, appearance, the HUD, titling, electricity prices, `protoStream`, the panel's display preferences |

**The guarded direction is per key.** Turning `autoApproveReadonly` off narrows and is an ordinary change; turning it on
is guarded. Each guarded key declares a `widens(from, to)` in code; a key that declares none is guarded in both
directions, so a missing declaration fails closed.

| Guarded key | Guarded direction | Why |
| --- | --- | --- |
| `autoApproveReadonly`, `autoApprovePython`, `autoApproveSelfSource` | on | runs calls without asking |
| `shellEnabled`, `shellRoots`, `shellPath`, `shellSandbox` | on; a root or path added; the sandbox off | what `ml.sh` may run and where (`SHELL.md`) |
| `pierceClosedShadow`, `cdp` | on | what a run reaches in a page, trusted input |
| `execDefaultWorld` | both | which world a script runs in decides what the page sees of it (`src/sw/exec-routing.ts`) |
| `agentStartPage` | both | a URL every blank run navigates to: an exfiltration channel the fetch gate never sees (threat model, item 1) |
| `apiFormat` | both | changes how every request to the server is written. Guarded to protect the person from a broken connection, not from the model: a wrong value cuts every run off from its model, and the run that made the change cannot change it back |
| `serverToolsOff`, `commanderServerTools` | a tool turned on | which server-side tools a run is given |
| `agentSeesFocus`, `selfIntrospection` | on | what the model is told about the person and its own run |
| `debugMode` | both | decides whether a page's `ml.agent` runs in the worker's loop or the page's (`MlPublicConfig`'s JSDoc) |
| `siteRequests`, `listPageSessions` | on | what pages may ask for, and what wakes on a page |
| `persistUiRuns`, `sessionArchive`, `sessionRetentionDays`, `sessionStoreBudgetMB`, `valueStoreBudgetMB`, `exportToolDefs` | off; a shorter retention; a smaller budget | the person's record of what the model did; a model must not be able to shorten its own audit trail without a card |

A model-name key (`model`, `ocrModel`, `utilityModel`, `embeddingModel`, `groundingModel`, `defaultModelVision`) is
ordinary and its value is validated as `setModel`'s is: it must be on the server's list and pass `modelFilterAllows`.

**Not settings, never on the whitelist**: the whitelist itself; global and run policies (`propose_policy` is the
model's route there); the site lists and the self-approval list; program manifests and Python libraries (each has its
own proposal path or none); the backup passphrase and keys; the archive folder's grant; pairing and hub keys. None of
them is a key of `DEFAULT_CONFIG`, so the class test does not see them; the whitelist's own validation refuses any key
that is not a classified one.

## The whitelist

- **Stored** in `chrome.storage.local`, key `ml_model_settings`, never `sync`: like policies (`docs/dev/policies.md`,
  "Scopes and lifetime"), it is about this browser. Declared in the state registry from its first commit
  (`defineState`, audience `model`, since the model reads what it permits).
- **Edited** in DevTools Settings → Permissions, one row per classified key, with a three-way choice (off, read,
  read and change) and the class shown. A secret's row has no choice and says why. The chat page's Settings → Extension
  shows the same view, as it does every other section.
- **Default**: the ordinary keys `read-write`, the guarded keys off, so a fresh install lets the model help with the
  harmless settings, each change still on a card, and the person opts in to the rest. Proposed on Shane's "no reason
  the model can't help" and ruled by the coordinator (2026-11-13, pending Shane); the alternative, an empty list until
  the person adds keys, stays open question 2 until Shane says.
- **Upgrade.** An install from before this has no `ml_model_settings`, and reads the default. A build from before this
  ignores the key. A stored entry naming a key that is not classified, or a secret, is dropped on read and not repaired
  (as `validList` drops a malformed policy). Tests: a fixture of an empty storage read by the new code, and a fixture of
  a whitelist naming `apiKey` and an unknown key, read as the default minus nothing and the list minus both.

## Who reaches it

Only a run the worker built (`SITE_ACCESS.md`, "Runs the user starts are built in the worker"): one started from the
sidebar, the DevTools panel, the chat page or over the hub. The guards are the ones `propose_policy` already has
(`docs/dev/policies.md`, "A proposal from the model"):

- the tool is offered only by `startUserRun`; `pageStartPayload` drops a page's descriptor of that name and
  `markWorkerRun` strips it from a page-built run handed to the worker;
- `ml.current.settings` is added only to the snapshot the worker builds for a run it built, and an exec naming
  `ml.current` runs in an isolated world or is refused (`src/sw/exec-routing.ts`), so a page's script never reads it;
- there is no `ml.*` member and no `HANDLE_MAP` entry for either half, so nothing on a page can name it; the existing
  `SET_MODEL` stays the page's only write.

## The surface

**Reading: `ml.current.settings`.** One entry per whitelisted key: `{ value, mode: "read" | "read-write", class:
"ordinary" | "guarded" }`. Absent when the list is empty or the run is not one the worker built. Read at each snapshot,
so a change the person makes in Settings is what the next survey sees.

**Writing: one tool, `change_setting({ key, value, why })`**, a builtin declared in the tool registry
(`defineBuiltinTool`), run in the worker. In order:

1. Refused, with no card, when the key is off the list or `read`, or when the value fails the key's own validation:
   its type (`configTypeOk`), its words (`CONFIG_ENUMS`), its range, a model name off the server's list or the filter,
   a string over a cap. The model is told why in one sentence.
2. Judged as the `setting` consumer: `judgeCall(runId, "setting", facts)`. A `deny` refuses with the policy named
   (`POLICIES.md`, "always reject is a policy"). An unloaded store asks.
3. An `allow` writes the change, unless the change is guarded, which asks.
4. Otherwise a card.

**The facts a `setting` policy sees**: `{ kind: "setting", key, from, to, class, widens, effects }`, where `widens` is
the key's declared direction applied to this change and `effects` is `unknown`, as for `act`. An unknown effect is
inside no bound, so the built-in default (`free()`) frees nothing here: every change the person did not write a policy
for asks. A person who wants the theme to follow the model's say writes `(c) => c.key === "theme"`, or has the model
propose it (`propose_policy` gains `setting` rows; its breadth is measured over every whitelisted key with sample values
from each key's domain, which for an enum key is the whole domain).

**The card**, rendered by the worker from the facts, never from the model's text, except `why`, shown as the model's
words:

> The agent wants to change **Auto-approve read-only surveys** from `off` to `on`.
> This runs read-only page surveys without asking. *(the `RISKY_CONFIG` text, for a guarded key)*
> The agent says: "…" *(`why`, at most 280 characters)*
> This applies to every browser signed in to this profile. *(for a key in `chrome.storage.sync`)*
> [Allow] [Deny, with a note]

Two answers, as every card (`POLICIES.md`, "Widening is a policy, never a button on a card"). A card for a guarded
change says it cannot be remembered.

**The write** is a compare-and-set: it lands only if the stored value still equals `from`, the value the card showed;
otherwise the card closes and the model is told the setting changed meanwhile. A `setting`/`changed` record goes to the
run log with the key, from, to and who answered (`docs/dev/run-log.md`); the tool result tells the model the old value
so it can say how to undo. A change takes effect as the same change made in Settings would, for this run included.

## Threat model

The attacker is a page the run reads (prompt injection into the model) or the model itself mistaken. The page cannot
call this surface (above); what it can do is ask the model, in text, to call it.

1. **Exfiltration through a setting that names a URL or a host.** A run that could set `chatUrl` would send the API key
   to that host on the next request; `priceSnapshotUrl` is fetched by the worker. Both are secrets, never on the list.
   `agentStartPage` is a URL every blank run navigates to, so setting it to `https://evil.example/?d=<data>` leaks data
   through a navigation the fetch gate never judges: it is guarded both ways, its card shows the host, and its value
   is also judged as a navigation (`navigateFacts`), so a `fetch` `deny` of that host refuses the change too. A string
   value is a second channel: `chrome.storage.sync` carries it to the person's other machines and to Google's sync, and
   a page-readable key (the 20 of `ml.config()`) carries it to every approved page. So no key on the list takes free
   text: every value is checked against a closed domain (an enum, a number range, a model on the server's list, a
   currency code, a parsed hour range), and a key whose value cannot be so checked is not classified ordinary.
2. **A setting that widens the model's own permissions.** `autoApproveReadonly`, `autoApprovePython`, the shell keys,
   `cdp`: one approved change and every later call runs unasked. Guarded: always a card in the widening direction, no
   policy can free it, so the model cannot `propose_policy` its way past it (a proposed `allow` naming a guarded key is
   refused at the precheck, with that reason). The site lists, the self-approval list and the whitelist are not settings
   at all, so a run cannot grant a page `window.ml` or put a key on its own list. Shrinking the record
   (`persistUiRuns`, retention, budgets) is guarded for the same reason in the other direction: it hides what was done.
3. **A page's run reaching it.** A page-started run, a page-built run handed to the worker, and a page's own
   `ml.agent` never have the tool or `ml.current.settings` ("Who reaches it"). A page reading the change afterwards
   through `ml.config()` reads only what it could read before.
4. **Forged approvals.** The card is drawn only on the extension's own surfaces and answered over the approval IPC by
   them, or over the hub by a principal holding `approve`; a page's message never answers it (the existing approval
   path; `docs/dev/agent-tools.md`, approvals over IPC). What the card shows is rendered from the facts, so the model's
   `why` cannot restate the change ("this only changes the theme"). The compare-and-set binds the answer to the change
   the card showed. A whitelist row removed, or a key reclassified, while a card shows closes the card refused.
   `rejudgePending` re-judges an ordinary change's card when a policy changes, and never answers a guarded one.
5. **Reading.** A whitelisted value reaches the model's context and, from there, anything the model writes (a fetch the
   person approves, a reply). No secret is ever on the list; the person putting a key on the list for `read` is the
   person accepting that the model knows its value. Error text from a refused write goes through `sw-scrub.ts`.
6. **Fatigue.** A model asking again and again for the same change. Open (question 4): the lean is that a denied change
   of the same key to the same value within a run is refused without a card, telling the model it was denied. That is
   run-scoped memory of the model's own refused call, kept with the run and gone with it: it can only refuse, never
   answer for the person, and it is not a policy, so it is not the remembered answer rule 2 excludes.
7. **Propagation.** The config lives in `chrome.storage.sync`, so a change the model makes on one browser lands on
   every browser signed in to the profile, including ones whose own whitelist does not name the key and ones the
   person is not looking at. The card says so (above), for every key in `sync`. A guarded change still writes to
   `sync`, not to this browser only: a browser-local override of a synced key would be a fourth copy of the config
   (`docs/dev/state.md`), with the questions every other copy raised about which one wins. The card is the control; a
   person who wants a setting to differ per browser has no way to say so today, with or without this spec. Display
   preferences in `chrome.storage.local` stay on this browser.

**Red-team rows** (e3, through the coordinator), what a hostile page or an injected model must not get:

- a read of any key off the whitelist, of any secret by any route, of `ml.current.settings` from a page's script or a
  page-started run;
- a write of any key off the list, of a `read` key, of a secret, or of a value outside the key's domain;
- a guarded change in its guarded direction without a card, by an `allow` policy of any origin, a proposed policy, a
  remembered answer or a policy file;
- a change to the whitelist, a policy, a site list or the self-approval list through `change_setting`;
- a card answered by a page's message, or an answer applied to a different value than the card showed;
- `agentStartPage` set to a host a `fetch` `deny` covers;
- a change to a `sync` key whose card does not say it applies to every browser signed in;
- the tool or the snapshot key reaching a page-built run through `startBackgroundRun`, `markWorkerRun` or a resume;
- an unclassified key in `DEFAULT_CONFIG` (the class test).

## Open questions

1. **Narrowing `ml.config()` for the model** (a later slice; the first ruled the 20 keys readable regardless, since
   the page can read them anyway and narrowing them would break `ml.agent`'s own vision wiring): narrow what a model's
   run reads of `ml.config()` to the whitelist where the worker can tell the call is the model's (an isolated-world
   exec).
2. **The default list**: ordinary keys `read-write` (ruled by the coordinator as proposed, pending Shane), or empty
   until the person adds keys.
3. **Per-key `widens` for lists** (`shellRoots`, `serverToolsOff`): a set comparison, which the declaration in code
   makes exact; whether a reorder counts as a change at all.
4. **Fatigue**: the repeat-refusal above, or nothing.
5. **Local display preferences** (`fontScale`, the code theme, the output cell height) live in `chrome.storage.local`
   and some in the panel's `localStorage`: whether those are on the whitelist in the first slice or follow it.
6. **A key the panel does not show.** `ocrNumCtx` is in `DEFAULT_CONFIG` and `ml.config()` but has no control in
   DevTools Settings; by rule 6 it is not whitelistable until it has one, which the standing rule wants anyway.
7. **Settings of other surfaces**: the chat page's "This page" tab is the device's own and is not the extension's
   config; out of scope here.

## Owners

Not assigned. The tool, the consumer and the store: whoever builds it, with the policies lane for the consumer. The
Settings section: the settings panel's owner.
