# Spec (proposed): settings the model can see and change

**Status: proposed 2026-11-13, nothing built.** From Shane's words in the calm-chat-motion session (2026-11-13) and the
points agreed there, handed to the settings-specs lane by the policies/python/desktop/manifests coordinator. Questions
1 and 2 of the first review (`ml.config()` stays as it is; the guarded class is not a second mechanism) were ruled by
Shane on 2026-11-13 as proposed. Shane also ruled on 2026-11-13:

- the model reads the settings through `ml.settings()`, not `ml.current.settings`: they are the person's global
  settings, and a name under `ml.current` says they belong to the run;
- fatigue: once the person declines a guarded change, the same key's change is refused for the rest of that run, with
  no card and a reason naming the earlier decline; nothing is remembered across runs ("Threat model", item 6).

**Ruling 2 (Shane, 2026-11-14), which replaces the first ruling's whitelist.** That ruling had a constant in code,
starting empty, with keys added one at a time; nothing was to be built until the first. Now `change_setting` reaches
every setting, because every call it makes is approval-gated, except:

- the secrets, which include the server URL (`chatUrl`) and `modelFilter`, excluded outright;
- the gate's own keys (`autoApproveReadonly`; the site lists and policies, which are not settings at all), excluded,
  with a link to the setting's row as the help. `autoApprovePython` and `autoApproveSelfSource` are classed with
  `autoApproveReadonly` for the same reason, that one approved change removes every later approval of their kind;
  confirmed by Shane, 2026-11-17;
- `shellEnabled` and the host connection settings (`shellRoots`, `shellSandbox`, `shellPath`) are read-write only with
  the card showing the old and the new value verbatim. The hub's connection (pairing, keys) is not a key of
  `DEFAULT_CONFIG` and stays outside this spec ("Not settings", below).

A consequence: every value but a secret's is READABLE by the model under ruling 2, the shell keys' folder and program
paths included ("Threat model", item 5). Starting the build is Shane's to confirm (coordinator, 2026-11-14).

A new agent-facing surface, so the threat model below is reviewed by the red team (e3, through the coordinator) before
this lands.

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

- **`ml.config()` returns a fixed subset**, `publicConfig()` in `src/contract/contract-config.ts`: 21 keys of the 58
  (`model`, `ocrModel`, `ocrNumCtx`, `apiFormat`, `defaultModelVision`, the three utility-model keys,
  `autoApproveReadonly`, `autoApprovePython`, `autoApproveSelfSource`, `serverToolsOff`, `commanderServerTools`,
  `selfIntrospection`, `pierceClosedShadow`, `cdp`, the three grounding keys, `debugMode`, `labelMatch`) plus the
  computed `pageApprovalAllowed`. `MlPublicConfig` names the same keys (`tests/api-docs.test.mjs`). It is
  the `GET_CONFIG` message (`src/background.ts`), the same view the worker hands its own run assembly (`workerMl`).
- **The model reads it free.** `config` is in `ML_READONLY_METHODS` (`src/readonly-exec/policy.ts`), so a read-only
  survey calls `ml.config()` with no card. So does any script on an approved origin.
- **The one write a page or the model has is `ml.setModel`** (`SET_MODEL`), validated against the server's model list
  (AGENTS.md: "Pages can change only the model").
- **The code already knows which settings matter**: `SECRET_KEYS` in `src/sw/sw-scrub.ts` (`chatUrl`, `apiKey`,
  `modelFilter`, `priceSnapshotUrl`) and `RISKY_CONFIG` in `src/backup/backup-settings.ts` (settings that send traffic
  or widen what runs without asking, which a restore lists apart with what each does).

That subset was chosen in code, for the page, and the page reads it too. What this spec adds is a view for the model,
with writes.

## The rule

1. **Every setting is read-write except the secrets and the gate's own keys** (ruling 2, Shane, 2026-11-14). The set
   is derived from the class declaration (below, "Four classes of setting"), never listed a second time, and the
   person does not edit it in this spec (open question 8). The model reads the value of every read-write key and of
   every key `ml.config()` already returns. A secret is listed with no value (below, "The surface"). A write to a
   secret or a gate key is refused, naming it as one the model may not change; a gate key's refusal links to its row.
2. **A change asks unless a policy allows it**, through the policy store (`POLICIES.md`), as a new consumer `setting`.
   One mechanism: no second store, no per-setting "always allow" button, no remembered answer of its own. (The
   fatigue refusal under "Threat model", item 6, is run-scoped memory of the model's own refused call, not an answer:
   it never lets a change through. Ruled by Shane, 2026-11-13.)
3. **A guarded change always asks**, whatever a policy says (below, "Four classes of setting"). Precedent: a
   credentialed fetch asks regardless of policy (`POLICIES.md`, "Scopes"). A policy may still DENY a guarded change.
   This is not a second mechanism: the same consumer, the same store and the same judge, and the guarded class is an
   answer the judge cannot free, as a credentialed fetch is (ruled by Shane, 2026-11-13).
4. **A page-started run never reaches it**: not the reads, not the tool, not the card (below, "Who reaches it").
5. **Secrets and the gate's own keys are never writable**, and neither are the stores that decide what the model may
   do (policies, site lists).
6. **The DevTools Settings panel is the superset.** A setting the panel does not show is not a setting for this
   purpose.

`ml.config()` is not changed by this spec. Its 21 keys stay readable by the model and by approved pages whatever their
class, because a page on an approved origin can call it itself and the worker cannot tell the model's call
from the page's (the sender is the tab either way). Rule 1 governs the new surface. Narrowing an isolated-world
exec's `ml.config()` is open question 1, a later slice.

## Slices

- **Discovery, built** (#1815, LINKS.md slice 1). `agent_api_docs` has a "Your settings" section: every setting by tab
  and section, with its link address, and which values `ml.config()` returns, generated from `SETTING_PLACES`,
  `PANEL_LAYOUT` and `publicConfig()`. A setting it lists and `ml.config()` does not return, the server URL and the API
  key among them, the model knows exists and cannot read.
- **The surface, one PR**: `ml.settings()`, `change_setting`, the `setting` consumer, the card (with the verbatim
  values the shell keys need), the fatigue refusal ("Threat model", item 6) and the red-team rows. Under ruling 2
  guarded keys are read-write from the first commit, so a change can be declined at a guarded card from the start, and
  the fatigue refusal cannot wait for a later key. Not started until Shane confirms (coordinator, 2026-11-14).

## Four classes of setting

Every key of `DEFAULT_CONFIG` is in exactly one class (the gate class joined the first three under ruling 2), declared
in code in `src/setting-class.ts` (`SETTING_CLASSES`, typed over every key of the config): the class; for an ordinary
key its domain; for a guarded key its `widens(from, to)`; and for a guarded, gate or secret key its reason, one sentence
saying what changing it does. That declaration supersedes `RISKY_CONFIG` (`src/backup/backup-settings.ts`) for both of
its readers:

- a guarded change's card shows the reason (below, "The surface");
- the restore preview's `risky` group (`groupOf`, and the sentence it prints) becomes "a `sync` key that is guarded,
  gate or secret", with the declaration's reason as its sentence. A secret is never on a card, but a restore still lists
  it apart, so the five secrets (`chatUrl`, `apiKey`, `modelFilter`, `priceSnapshotUrl`, `pageApprovalDomains`) keep a
  reason, carried over from `RISKY_CONFIG` word for word, and the `chatUrl` sentence about a backup with no API key
  stays the restore's own.

`RISKY_CONFIG` has a sentence for 17 keys today: those five and 12 of the 22 guarded and 3 gate keys. The restore's
`risky` group therefore widens from 17 keys to 30, on purpose: a setting the model may not change without a card, or at
all, is also one a restore lists apart. The builder deletes `RISKY_CONFIG`, so what a setting does has one source. The
restore preview's test is updated to the 30 keys by enumerating the declaration, not by copying the list.

**What a person sees on restore changes with it** (built 2026-11-17): restoring a backup now lists 30 settings apart
with what each does, where it listed 17. The 13 new ones are the guarded keys `RISKY_CONFIG` had no sentence for
(`serverToolsOff`, `commanderServerTools`, `agentSeesFocus`, `selfIntrospection`, `debugMode`, `siteRequests`,
`listPageSessions`, `persistUiRuns`, `sessionArchive`, `sessionRetentionDays`, `sessionStoreBudgetMB`,
`valueStoreBudgetMB`, `exportToolDefs`); the 17 keep their sentences word for word. The upgrade test reads a backup an
older version wrote that changes every setting (`tests/fixtures/backup/settings-every-key-v1.json`) and asserts the 30.

The domain is a closed union in the declaration's type, so a new kind of domain is a change to the type, not a new
value:

```ts
type Domain =
  | { kind: "boolean" }
  | { kind: "enum"; words: readonly string[] }          // CONFIG_ENUMS' words
  | { kind: "number"; min: number; max?: number; integer?: true }   // no max: unbounded above
  | { kind: "model" }                                    // on the server's list and modelFilterAllows, as setModel
  | { kind: "hours" }                                    // electricityOffPeakHours' hour range, its parser by name
  | { kind: "currency" };                                // an ISO 4217 code the runtime knows (Intl.supportedValuesOf)
```

`currency` was added when the declaration was built: `electricityCurrency` is free text in the panel, and threat item 1
already counted "a currency code" as a closed domain. None of the six admits an arbitrary string, so a future `*Url`,
`*Template`, `*Prompt` or `*Header` key cannot be declared ordinary without a new member of the union, which a reviewer
sees; it is classified guarded or secret instead. A guarded, gate or secret key declares no domain here: its value is
validated as today (`configTypeOk`, `CONFIG_ENUMS`).

**What the model may change is derived, not declared a second time.** `modelWritable(key, places)` is true when the
key is classified, is neither secret nor gate, and has a place in `places`, the table beside `DEFAULT_CONFIG` naming
each key's tab and section in DevTools Settings (`SETTING_PLACES`, #1815). It is the one function `ml.settings()`,
`change_setting` and their tests call. `places` is a parameter so the test can pass the real table and a table with a
row added: a key with no control has no place, so it is not writable, and the same table is what LINKS.md's test
checks against the panel's `data-setting` rows, so a place cannot be claimed for a control that does not exist. A new
setting is therefore read-write the moment it is classified ordinary or guarded and given a row; its class is the
review.

A `number` domain with no `max` is unbounded above: `pythonIdleMinutes`, `sessionRetentionDays` and
`sessionStoreBudgetMB` are at least 0 with no ceiling in DevTools Settings today.

**The class test** enumerates `DEFAULT_CONFIG` (AGENTS.md: enumerate the inputs, do not sample them) and fails on:

- a key with no class, so a new setting cannot land unclassified;
- a guarded, gate or secret key with no reason, so no card and no restore shows a change without saying what it does;
- a gate key with no place, since its refusal links to its row;
- an ordinary key with no domain, or with one outside the union (a type error, and the test asserts each declared
  `kind` is one of the six, for a declaration built at run time);
- `modelWritable` true for a key with no place, or for a secret or gate key. `ocrNumCtx` is the fixture: it is
  classified ordinary, has no control in DevTools Settings today (open question 6) and no place, so with the real
  table it is not writable, and with a table given a row for it it is. The test is therefore green today and fails if
  `modelWritable` stops reading the table.

**A key nobody classed fails closed.** A key added to `DEFAULT_CONFIG` with no class is a type error
(`SETTING_CLASSES` is typed over every key of `MlConfig`) and fails the class test's first row. Were it to reach a
build anyway, `settingDecl` answers `null` for it, so `change_setting` refuses it as no setting, `ml.settings()` leaves
it out even with a row in DevTools Settings, and `ml.config()` does not carry it either, being an allowlist
(`publicConfig`, `contract-config.ts`): unwritable and unreadable by the model. Pinned by
`tests/change-setting.test.mjs`, "a key nobody classed is neither listed nor writable". The gate keys other lanes are
adding (the hide list, and ruling 31's per-program opt-in for process-listing programs) are therefore excluded until
someone classes them, and classing one `gate` reds the gate row's literal in `tests/setting-class.test.mjs`, so the
ruled list is updated in the same change.

**The panel's display preferences are out of this spec**: `fontScale`, the code theme and its custom
VS Code import, the output cell height, the stats toggles. They are not keys of `DEFAULT_CONFIG` (they live in
`chrome.storage.local` and the panel's `localStorage`, read through `src/sidebar/store.ts`), the custom theme's value
is an arbitrary JSON document, and they change only how this browser draws. Bringing them in needs a home for their
class beside their own keys in `store.ts` and the same domain union; that is open question 5.

| Class | Read-write | A change | Keys (the initial classification; the code's table is the truth) |
| --- | --- | --- | --- |
| **secret** | never; not readable | impossible | `chatUrl`, `apiKey`, `modelFilter`, `priceSnapshotUrl` (exactly `SECRET_KEYS`), and the legacy `pageApprovalDomains` (it is a site list) |
| **gate** | never; readable through `ml.config()`, or only through `ml.settings()` for `shellRevealsAllow` | impossible; refused with a link to the row (`window-ml:setting/<key>`, LINKS.md), so the model can say where the person changes it | `autoApproveReadonly`, `autoApprovePython`, `autoApproveSelfSource`, `shellRevealsAllow` (the programs that reveal other processes the person lets run free, [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)): the approval gate itself, where one approved change would remove every later approval of its kind |
| **guarded** | yes | always asks, in either direction; a policy may deny, never allow | what widens what the model reaches; what sends the person's data somewhere it did not go before; what shrinks the person's record of what happened. Exactly the next table |
| **ordinary** | yes | asks unless a policy allows it | everything else: models and their context sizes, appearance, the HUD, titling, electricity prices, `protoStream`, the Python idle and detached-task limits. `autoTitles` and `groundingEnabled` send more to the model server when turned on, and are ordinary on purpose: they reach only the server the person configured, with data already going there |

**A guarded key's change always shows its card, in either direction; `widens` is a fact a policy may read, to deny a
widening change, and never frees one** (ruled by the coordinator, 2026-11-17, to match the build). Turning `cdp` off
asks just as turning it on does, whatever a policy says. Each guarded key declares a `widens(from, to)` in code, and a
key that declares none widens both ways, so a missing declaration fails closed. Why both directions: it fails closed,
and the direction of a change is not always decidable for a list or a path key.

| Guarded key | Guarded direction | Why |
| --- | --- | --- |
| `shellEnabled`, `shellRoots`, `shellPath`, `shellSandbox` | on; a root or path added; the sandbox off | what `ml.sh` may run and where (`SHELL.md`). The card shows the old and the new value verbatim, every path in full, in both directions (ruling 2) |
| `pierceClosedShadow`, `cdp` | on | what a run reaches in a page, trusted input |
| `execDefaultWorld` | both | which world a script runs in decides what the page sees of it (`src/sw/exec-routing.ts`) |
| `agentStartPage` | both | a URL every blank run navigates to: an exfiltration channel the fetch gate never sees (threat model, item 1) |
| `apiFormat` | both | changes how every request to the server is written. Guarded to protect the person from a broken connection, not from the model: a wrong value cuts every run off from its model, and the run that made the change cannot change it back |
| `serverToolsOff`, `commanderServerTools` | a tool turned on | which server-side tools a run is given |
| `agentSeesFocus`, `selfIntrospection` | on | what the model is told about the person and its own run |
| `debugMode` | both | decides whether a page's `ml.agent` runs in the worker's loop or the page's (`MlPublicConfig`'s JSDoc) |
| `siteRequests`, `listPageSessions` | on | what pages may ask for, and what wakes on a page |
| `persistUiRuns`, `sessionArchive`, `sessionRetentionDays`, `sessionStoreBudgetMB`, `valueStoreBudgetMB`, `exportToolDefs` | off; a shorter retention; a smaller budget | the person's record of what the model did; a model must not be able to shorten its own audit trail without a card |

The five model-name keys (`model`, `ocrModel`, `utilityModel`, `embeddingModel`, `groundingModel`) are ordinary, and
each value is validated as `setModel`'s is: it must be on the server's list and pass `modelFilterAllows`.
`defaultModelVision` reads like one but is the enum `""`, `yes`, `no`.

**Not settings, never writable**: global and run policies (`propose_policy` is the model's route there); the site lists
and the self-approval list; program manifests and Python libraries (each has its own proposal path or none); the backup
passphrase and keys; the archive folder's grant; pairing and hub keys; the secret values the person types in Settings
(`secretRegistry`, `chrome.storage.local`, files-host's registry), a secret by name: never readable through
`ml.settings()`, never writable. None of them is a key of `DEFAULT_CONFIG`, so `change_setting` cannot name them: a key
that is not a classified one is refused.

## The read-write set

- **Derived, not stored**: `modelWritable` over the class declaration (`src/setting-class.ts`) and `SETTING_PLACES`
  (`src/contract/contract-config.ts`). Changing a key's class is a code change, reviewed like any other. Nothing of it
  is stored, synced or backed up, so a restore and an upgrade have nothing of it to carry. The values `ml.settings()`
  reads are the config's own, in `chrome.storage.sync`.
- **What is in it** (ruling 2, Shane, 2026-11-14): every classified key with a place, less the five secrets and the
  four gate keys, which is 49 of the 59 keys of `DEFAULT_CONFIG` today (`ocrNumCtx` and `pageApprovalDomains` have
  no place). The class decides what a change costs: an ordinary key's change asks unless a policy allows it, a guarded
  key's always asks.
- **No Settings section edits it** in this spec, so it has no link address of its own. A person narrowing it is open
  question 8.

## Who reaches it

Only a run the worker built (`SITE_ACCESS.md`, "Runs the user starts are built in the worker"): one started from the
sidebar, the DevTools panel, the chat page or over the hub. The guards are the ones `propose_policy` already has
(`docs/dev/policies.md`, "A proposal from the model"):

- the tool is offered only by `startUserRun`; `change_setting` joins `WORKER_ONLY_TOOLS`, so `pageStartPayload` drops
  a page's descriptor of that name and `withoutWorkerOnly` strips it from the stored copy of a page-built run handed to
  the worker (`src/sw/sw-runs.ts`). The set was `PROPOSAL_TOOLS` (and the function `withoutProposals`) until this was
  built: `change_setting` proposes nothing to store, so the name became what the set is, "the tools only a run the
  worker built offers: they ask the person to store or change something the model drafted";
- every place a run becomes one the worker built is enumerated, not sampled: `startUserRun`, the hand-over
  (`markWorkerRun`), adoption (`adoptSession` in `src/sw/sw-sessions.ts`, which hydrates a saved session's payload and
  calls `makeWorkerRun`) and the resume. On the three that are not `startUserRun` the toolset is the payload's, which
  cannot carry `change_setting`; a test per caller asserts none yields the tool or `ml.settings()` to a page;
- `ml.settings()` exists only on the `ml` an isolated-world exec gets in a run the worker built, and an exec naming
  it is routed as one naming `ml.current` is: in an isolated world, or refused (`src/sw/exec-routing.ts`, whose test
  for `ml.current` grows `ml.settings`), so a page's script never reads it;
- `injected.ts` does not define it on the page's `window.ml`, and there is no `HANDLE_MAP` entry for either half, so
  nothing on a page can name it; the existing `SET_MODEL` stays the page's only write.

## The surface

**Reading: `ml.settings()`**, built with the surface ("Slices"). The model's one view of the settings: one entry per
classified key with a place in `SETTING_PLACES` (a row in the panel), the secrets included: the rule that keeps a key
out of the read-write set (rule 6) also keeps it out of the entries, so every entry's doc can name where the setting
lives. A key with no place (today `ocrNumCtx`) is read through `ml.config()` until it gets a control (open question 6).
An entry carries a value wherever the model may read it by any route, which is the 21 keys `ml.config()` already returns
plus every read-write key and `shellRevealsAllow` (a gate key `ml.config()` does not return: a page has no use for the
list, and the model reads it to say why a call asked); only a secret's entry is hidden:

```ts
model:        { value: "qwen3:14b", mode: "read", class: "ordinary" }   // also returned by ml.config()
theme:        { value: "dark", mode: "read-write", class: "ordinary" }  // editable
shellEnabled: { value: false, mode: "read-write", class: "guarded" }    // editable; the card always shows
autoApproveReadonly: { value: true, mode: "read", class: "gate" }       // readable, never changed by the model
apiKey:       { mode: "hidden", class: "secret" }                       // never readable
```

So `ml.settings()` never contradicts `ml.config()`. `ml.config()` stays as it is: the page-facing API, a fixed 21 keys,
for approved pages and the model alike. A hidden entry has no `value` field at all, never `null` or `""`, which would
say whether it is set. Each entry's doc names where the setting lives, so the model can link to it
(`[your API key](window-ml:setting/apiKey)`, LINKS.md). Its doc says they are the person's settings for this browser,
the same for every run, and that a change to one is a change everywhere. The worker reads the classes
and the values each time an exec calls it, so a change the person makes in Settings is what the next survey sees. It
reaches the model only through an exec run in an isolated world: where no isolated world is available, an exec naming
`ml.settings` is refused (`src/sw/exec-routing.ts`), so on that setup the model reads no setting through this surface,
while `change_setting`, which runs in the worker, still works and its result names the old value. The refusal stays a
refusal when this is built: never a main-world fallback for `ml.settings()`.

**Writing: one tool, `change_setting({ key, value, why })`**, a builtin declared in the tool registry
(`defineBuiltinTool`), run in the worker. In order:

1. Refused, with no card, when the key is a secret, a gate key (the refusal links to its row) or has no place, or when
   the value fails the key's own validation:
   its type (`configTypeOk`, `src/setting-class.ts`), its words (`CONFIG_ENUMS`), its
   range, a model name off the server's list or the filter, a string over a cap. The model is told why in one
   sentence.
2. Judged as the `setting` consumer: `judgeCall(runId, "setting", facts)`. A `deny` refuses with the policy named
   (`POLICIES.md`, "always reject is a policy"). An unloaded store asks.
3. An `allow` writes the change, unless the change is guarded, which asks.
4. Otherwise a card.

**The facts a `setting` policy sees**: `{ kind: "setting", key, from, to, class, widens, effects }`, where `widens` is
the key's declared direction applied to this change and `effects` is `unknown`, as for `act`. An unknown effect is
inside no bound, so the built-in default (`free()`) frees nothing here: every change the person did not write a policy
for asks. A person who wants the theme to follow the model's say writes `(c) => c.key === "theme"` on the policy page,
whose add form takes the consumer.

**Who writes a `setting` policy, and what it frees** (as `docs/dev/policies.md`, "The `setting` consumer"). An `allow`
frees an ORDINARY change only, with no card; a guarded change shows its card whatever a policy says, in both
directions, and a `deny` refuses either. The person writes one today, on the policy page or in a policy file.
`propose_policy` does NOT accept consumer `setting` as built: `checkProposal` (`src/sw/policy-proposal.ts`) refuses
any consumer but `fetch` and `act`, pinned by `tests/propose-policy.test.mjs`, "a proposal for consumer setting is
refused". The model asking for a standing allow over settings is open question 10. No `setting` allow frees a guarded
key, a shell key or `agentStartPage`: `judgeSettingChange` frees class `ordinary` alone, and every shell key and
`agentStartPage` is held to a class other than ordinary by `tests/setting-class.test.mjs`, "no shell key and not
agentStartPage is ever ordinary".

**The card**, rendered by the worker from the facts, never from the model's text, except `why`, shown as the model's
words:

> The agent wants to change **Auto-approve read-only surveys** from `off` to `on`.
> This runs read-only page surveys without asking. *(the class declaration's reason, for a guarded key)*
> The agent says: "…" *(`why`, at most 280 characters)*
> This applies to every browser signed in to this profile. *(for a key in `chrome.storage.sync`)*
> [Allow] [Deny, with a note]

Two answers, as every card (`POLICIES.md`, "Widening is a policy, never a button on a card"). A card for a guarded
change says it cannot be remembered. A card for a shell key (`shellEnabled`, `shellRoots`, `shellSandbox`,
`shellPath`) shows the old and the new value verbatim, every path of a list in full and in order, never a count, a
summary or a diff alone (ruling 2).

Every card also shows the setting's name and tooltip as its row in DevTools Settings shows them, read from the one table
both render from (`SETTING_TEXT`, `src/setting-text.ts`), so the person reads the same words in both places. The model
reads none of that text: `ml.settings()` carries no names or tooltips, and neither the tool's description nor its
results quote them, so a tooltip costs nothing in the prompt budget and is edited for the person alone.

For `agentStartPage` the card also shows the new value's host. A host no `fetch` policy covers is asked like any
other guarded change: the built-in default frees nothing, and an uncovered host is neither refused nor marked on
the card as one. A host spelled two ways (an IDN and its punycode, a trailing dot) is judged as the URL parser
reads it, the parser `navigateFacts` uses for the navigation itself.

A card that closes because its setting changed elsewhere is a denial no one gave: the model reads "Denied by the
extension, before the person answered" and the key's name, never its old or new value, and the run log gets a `setting`/`card-closed` record
whose reason is `worker`. A guarded change declined by the person is not asked again in the same run: the call is
refused with no card (the run's memory of it is in `storage.session`, so it outlives a worker restart and goes with
the browser).

**The write** is a compare-and-set against storage at the moment of the write: `from` is the value the worker read
when it judged the call, which is the value the card shows; when the answer comes, the worker reads the key again and
writes only if it still equals `from`. A change from anywhere else in between (the person in Settings, another
browser's write arriving through `sync`) makes the answer stale: the card closes, nothing is written, and the model is
told the setting changed meanwhile. A card already showing also closes on `chrome.storage.onChanged` for its key,
before any answer. A `setting`/`changed` record goes to the
run log with the key, from, to and who answered (`docs/dev/run-log.md`); the tool result tells the model the old value
so it can say how to undo. A change takes effect as the same change made in Settings would, for this run included.

## Threat model

The attacker is a page the run reads (prompt injection into the model) or the model itself mistaken. The page cannot
call this surface (above); what it can do is ask the model, in text, to call it.

1. **Exfiltration through a setting that names a URL or a host.** A run that could set `chatUrl` would send the API key
   to that host on the next request; `priceSnapshotUrl` is fetched by the worker. Both are secrets, never writable.
   `agentStartPage` is a URL every blank run navigates to, so setting it to `https://evil.example/?d=<data>` leaks data
   through a navigation the fetch gate never judges: it is guarded both ways, its card shows the host, and its value
   is also judged as a navigation (`navigateFacts`), so a `fetch` `deny` of that host refuses the change too. A string
   value is a second channel: `chrome.storage.sync` carries it to the person's other machines and to Google's sync, and
   a page-readable key (the 21 of `ml.config()`) carries it to every approved page. So no ordinary key takes free
   text: every value is checked against a closed domain (an enum, a number range, a model on the server's list, a
   currency code, a parsed hour range), and a key whose value cannot be so checked is not classified ordinary.
2. **A setting that widens the model's own permissions.** The gate keys (`autoApproveReadonly`, `autoApprovePython`,
   `autoApproveSelfSource`, `shellRevealsAllow`): one approved change and every later call of its kind runs unasked,
   so they are never writable. The shell keys and `cdp` widen what an approved call reaches: guarded, always a card in
   the widening direction, no policy can free it, so the model cannot `propose_policy` its way past it (a proposed
   `allow` naming a guarded key is refused at the precheck, with that reason). The site lists and the self-approval list are
   not settings at all, so a run cannot grant a page `window.ml`.
   Shrinking the record (`persistUiRuns`, retention, budgets) is guarded for the same reason in the other direction: it
   hides what was done.
3. **A page's run reaching it.** A page-started run, a page-built run handed to the worker, and a page's own
   `ml.agent` never have the tool or `ml.settings()` ("Who reaches it"). A page reading the change afterwards
   through `ml.config()` reads only what it could read before.
4. **Forged approvals.** The card is drawn only on the extension's own surfaces and answered over the approval IPC by
   them, or over the hub by a principal holding `approve`; a page's message never answers it (the existing approval
   path; `docs/dev/agent-tools.md`, approvals over IPC). What the card shows is rendered from the facts, so the model's
   `why` cannot restate the change ("this only changes the theme"). The compare-and-set binds the answer to the change
   the card showed. A key reclassified while a card shows closes the card refused.
   `rejudgePending` re-judges an ordinary change's card when a policy changes, and never answers a guarded one.
5. **Reading.** A readable value reaches the model's context and, from there, anything the model writes (a fetch the
   person approves, a reply). Under ruling 2 that is every key but the secrets, the shell keys' folder and program
   paths included, which name the person's directories; no secret is ever readable, and a key's class changes only
   through a reviewed change to the declaration. A hidden entry carries the key's name, class and place only, which
   the source and `agent_api_docs` already publish: never the value, its length, a hash of it, or whether it is set.
   Error text from a refused write goes through `sw-scrub.ts`.
6. **Fatigue.** A model asking again and again for the same change. Once the person declines a guarded change, a
   change of the same key, to any value, is refused for the rest of that run with no card and a reason naming the
   earlier decline; nothing is remembered across runs (Shane, 2026-11-13). That is run-scoped memory of the model's own
   refused call, kept with the run and gone with it: it can only refuse, never answer for the person, and it is not a
   policy, so it is not the remembered answer rule 2 excludes. Built in the PR that adds the first guarded key. It
   is run state, so that commit declares it beside the run store with `defineState` (`src/state-registry.ts`,
   `docs/dev/state.md`): not a fourth copy, and the state inspector shows it.
7. **Propagation.** The config lives in `chrome.storage.sync`, so a change the model makes on one browser lands on
   every browser signed in to the profile, including ones the person is not looking at. The card says so (above), for
   every key in `sync`. A guarded change still writes to
   `sync`, not to this browser only: a browser-local override of a synced key would be a fourth copy of the config
   (`docs/dev/state.md`), with the questions every other copy raised about which one wins. The card is the control; a
   person who wants a setting to differ per browser has no way to say so today, with or without this spec. Display
   preferences in `chrome.storage.local` stay on this browser. Inbound is covered by the compare-and-set: a value
   synced in from another browser while a card shows closes the card, and an answer never writes over it.

**Red-team rows** (e3, through the coordinator), what a hostile page or an injected model must not get:

- a read of any secret by any route, or of `ml.settings()` from a page's script or a page-started run;
- a write of a secret, of a gate key, of a key with no place, or of a value outside the key's domain;
- a guarded change in either direction without a card, by an `allow` policy of any origin, a proposed policy, a
  remembered answer or a policy file;
- a change to a gate key, a policy, a site list or the self-approval list through `change_setting`, and a gate key's
  refusal that does not link to its row;
- a card answered by a page's message, or an answer applied to a different value than the card showed;
- `agentStartPage` set to a host a `fetch` `deny` covers, and to the same host spelled so two parsers could disagree:
  userinfo (`https://good.example@evil.example/`), a trailing dot, an IDN and its punycode, a non-http(s) scheme
  (`data:`, `javascript:`, `chrome-extension:`), and the host reached through a redirect a navigate would follow;
- an ordinary change freed by the built-in default (`free()` over `unknown` effects is false: a refactor that makes it
  true fails this row), and any change, ordinary or guarded, written while the policy store is not yet loaded;
- a write landing over a value that changed after the card was drawn, by the person in Settings or by `sync` from
  another browser;
- a change to a `sync` key whose card does not say it applies to every browser signed in;
- a shell key's card that shortens, elides or summarises either value: a long path, a path with a newline or a
  right-to-left mark in it, a list of more roots than fit;
- the tool or the snapshot key reaching a page-built run through any caller of `makeWorkerRun` or `markWorkerRun`:
  `startBackgroundRun`, the hand-over, `adoptSession`, a resume;
- `ml.settings()` served from the main world where no isolated world exists;
- the class test's five failures: an unclassified key, a guarded, gate or secret key without a reason, a gate key with
  no place, an ordinary key with no domain or one outside the union, `modelWritable` true for a key with no place
  (`ocrNumCtx`) or for a secret or gate key;
- a hidden or secret entry in `ml.settings()` carrying its value, its length, a hash or prefix of it, or whether it is
  set; a write to a hidden key that changes anything.

## Open questions

1. **Narrowing `ml.config()` for the model** (a later slice; Shane ruled on the first review, 2026-11-13, that the 21
   keys stay readable regardless, since the page can read them anyway and narrowing them would break `ml.agent`'s own
   vision wiring): narrow what a model's run reads of `ml.config()` to the read-write set where the worker can tell the
   call is the model's (an isolated-world exec).
2. **Which keys the model may change.** RULED by Shane (ruling 2, 2026-11-14), replacing the first ruling's empty
   whitelist: every key but the secrets and the gate keys, with the shell keys' card showing both values verbatim.
   `autoApprovePython` and `autoApproveSelfSource` as gate keys: confirmed by Shane, 2026-11-17.
3. **Per-key `widens` for lists** (`shellRoots`, `serverToolsOff`): a set comparison, which the declaration in code
   makes exact; whether a reorder counts as a change at all.
4. **Fatigue**: RULED by Shane (2026-11-13), as threat item 6 reads: after one decline, the same key at all, for the
   rest of the run, with nothing remembered across runs.
5. **Local display preferences** (`fontScale`, the code theme, the output cell height) are out of
   this spec (above, "Four classes of setting"). Whether a later slice brings them in, with their class declared
   beside their keys in `src/sidebar/store.ts` and the custom VS Code theme kept off as an open domain.
6. **A key the panel does not show.** `ocrNumCtx` is in `DEFAULT_CONFIG` and `ml.config()` but has no control in
   DevTools Settings, so it is not writable; whether it gets a control (which the standing rule
   for a setting wants anyway) is the panel owner's call.
7. **Settings of other surfaces**: the chat page's "This page" tab is the device's own and is not the extension's
   config; out of scope here.
8. **A person narrowing the set**: a list stored per browser (`chrome.storage.local`), backed up with the policies,
   edited in DevTools Settings → Permissions with a three-way choice per key (off, read, read and change), the 21 keys
   of `ml.config()` marked readable regardless, and given a section id there so the model can link to it. It could
   only narrow ruling 2's set, never widen it past the secrets and the gate keys. Out of this spec.
9. **`ml.settings()` in a read-only survey** (a follow-up PR of its own, after the surface). As built, `ml.settings()`
   exists only on an isolated exec's `ml`, so every read of the settings costs the person an exec card. Bringing it
   to the survey needs: an `ML_READONLY_METHODS` entry; the member on the wire only for a client of a run the worker
   built; the secret and gate classes unreadable there as they are on the isolated exec; the dialect's adversarial
   tests (`docs/dev/readonly-exec.md`, "The rule for extending the dialect"); and a red-team pass.
10. **`propose_policy` rows of consumer `setting`** (part (c), its breadth measure spec'd to the coordinator before any
    code). RULED by the coordinator (2026-11-17): it may, since the card is the person's; the card must name the keys
    or the key pattern the allow covers, measured over every read-write key with sample values from each key's domain
    (for an enum key, the whole domain); and no `setting` allow ever frees a guarded key, a shell key or
    `agentStartPage`. Refused as built (above, "Who writes a `setting` policy").

## Owners

Not assigned. The tool, the consumer and the store: whoever builds it, with the policies lane for the consumer. A
Settings section for a list the person edits (open question 8) would be the settings panel's owner's.
