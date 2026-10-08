# Spec: reaching someone who is not looking at the app (2026-10-04)

Two things in this product are worth interrupting someone for, and they are interrupted by opposite
mechanisms. This is which, why, and what is still missing.

| What | How it reaches you | With the app closed |
| --- | --- | --- |
| this device's certificate is running out | dates handed to the OS in advance | **yes**, on the phone app |
| an approval is waiting | posted the moment this device learns of one | no: nothing here is running to learn of it |

The rule and every sentence live in one pure module, [`src/chat/reminders.ts`](../../src/chat/reminders.ts), shared by
both surfaces. The phone's OS plumbing is `mobile/src/notify.ts`; the hosted client's is
[`src/chat/notify.ts`](../../src/chat/notify.ts). Neither decides anything.

## The certificate is a schedule, not a push

A certificate's end is a date **this device already holds**. Nothing has to travel and no server has to be awake, so
the honest mechanism is to hand the OS the dates and let it wake itself. That works with the app closed, the network
down, and every browser on the account asleep, which is more than a push could manage: a push needs a sender that is
awake, and the case this exists for is precisely the one where nothing of the user's is.

Four notifications, at the inbox's own thresholds so the first lands exactly as the item appears there:

| id | when | why that one |
| --- | --- | --- |
| `cert-warn` | 14 days before (`CERT_WARN_MS`) | early enough that the two devices a renewal needs will be awake together at some point |
| `cert-urgent` | 3 days before (`CERT_URGENT_MS`) | below this it stops being something to get round to |
| `cert-last` | 1 day before | the last moment a press still works |
| `cert-gone` | at the deadline | it cannot be acted on, which is the point: the device has silently stopped reaching the account |

Anything already in the past is left out rather than fired late. A device first paired *inside* the warning window
would otherwise be told, on the spot, about a threshold that passed before the app existed, and the inbox is already
saying it on screen.

Only the **durable** half of the certificate reaches a reminder: `notAfterMs`, `mayRevoke`, `renewable`. `CertState`
(`src/chat/attention.ts`) also carries `issuerOnline` and `canRenew`, which are readings of right now; baking either
into a notification set for next month would put a sentence on a lock screen that was true when it was scheduled and
wrong when it arrived. There is a test for exactly that.

The ids are stable and the dates move, so scheduling the plan again **replaces** rather than duplicates: a renewal is
a replan and nothing has to be reconciled.

## An approval is the opposite case

An approval is a fact that originates on a laptop, so this device can only be told. It is posted the moment the
already-connected client learns of one, and only while this surface is not being looked at.

Two failures that shapes around, both of which are the `movedSince` lesson in another costume:

- The **first** report is the baseline, never news. An app opened with three approvals already waiting would
  otherwise announce all three, and the screen that just opened is where they are all listed.
- A rise seen while the list is on screen is taken as seen, not deferred. Someone reading the thing is not notified
  about it, and is not notified about it later either.

One notification for all of them, carrying the **total** waiting rather than the rise. A notification per session
would say how many sessions are busy, which is the one thing it is not allowed to say.

## What a notification may say

Nothing about a session, a task or a page. A certificate line is about this device's own access, which is the one
subject that is already the reader's; an approval line says only that one is waiting. This is the rule
[`NATIVE_SHELL.md`](NATIVE_SHELL.md) and [`CHAT_PAGE.md`](CHAT_PAGE.md) already stated for pushes, and it is kept for
local notifications too: the reason is a lock screen in a cafe, not the hub, so it does not relax just because
nothing left the device.

A test asserts it over every branch of every line.

## Per surface

| Surface | Certificate | Approval | Icon badge |
| --- | --- | --- | --- |
| phone app (`mobile/`) | scheduled with the OS; survives a reboot (`RECEIVE_BOOT_COMPLETED`, from the library's own manifest) | while the app is running or just behind something else | `setBadgeCountAsync`; iOS puts it on the icon, Android leaves it to the launcher |
| hosted client installed as an app | shown when the page is next alive, including backgrounded | same | `navigator.setAppBadge` (`src/chat/app-badge.ts`) |
| hosted client in a tab, extension page | same, while the tab is open | same | nothing: the Badging API is specified to do nothing in a tab |

The web gap is not a bug to fix in the client: **a web page cannot be woken at a date.** The Notification Triggers
API never shipped anywhere, so with the app closed there is no timer and nothing fires. Two cases follow, and they
are answered differently on purpose:

- A plan the page was **holding** across the moment (a laptop asleep with the tab open, an installed app behind
  something else) fires **late** when it wakes. The timer is capped at six hours for exactly this, so a long sleep
  comes back and checks rather than overflowing; the deadline has not moved, and being told on Tuesday about Monday's
  threshold is worth more than silence.
- A threshold that passed while the app was **closed** is not announced on opening. `certReminders` leaves a past
  date out of the plan, and the moment the app opens is the moment the inbox says it on screen, which is a better
  surface than a notification about something you are already looking at.

`registration.showNotification` rather than `new Notification()`: Android's Chrome throws on the constructor and has
for years, so a page that only knows the constructor is silent on most phones. The constructor is the fallback for a
desktop browser with no worker, which is every extension page here.

## Permission

Asked **only on a press**, on a Settings row that says what allowing it gets you. A prompt nobody opened is answered
"no" and then, on both platforms, cannot be asked again from inside the app. The row says what it will and will not
say, because "allow notifications" alone is a question nobody can answer.

`denied` is a dead end the row names, and it is a DIFFERENT dead end per surface (`notifyDeniedNote`):

- In a browser, that browser's own site settings.
- On the phone app, the phone's settings.
- **On an installed iOS or iPadOS web app, there is no second ask at all.** The permission belongs to that installed
  copy, and the only way to be asked again is to remove it from the Home Screen and add it again. That is not a free
  action: an installed web app's storage is its own container, separate from the browser's, and removing it takes the
  container with it. This device's keys live there, so the remedy is also what makes it a stranger to the account.
  The row says so and says it is not worth it for a notification.

The same container split is a trap in the other direction, and the `add-to-home` item now says so before it costs
anything: pairing the hosted client in a Safari **tab** and then adding it to the Home Screen gives an installed copy
with an empty container, in no account, which has to be paired on its own. The item says to pair it once it is on the
home screen rather than before.

Home-screen web apps are otherwise a sound place to keep an identity: they are exempt from Safari's seven-day cap on
script-writable storage, which a site in a tab is not, so the keyring is not evicted for being unused.

## No iOS push entitlement

`expo-notifications` is installed but **not** added to `app.json`'s plugins, deliberately. Its iOS config plugin
writes `aps-environment` and the `remote-notification` background mode, which are a push capability a free Apple
signing certificate cannot grant: adding it would break the iOS build for a feature that is local-only. Autolinking
still links the module, and Android gets `POST_NOTIFICATIONS` and `RECEIVE_BOOT_COMPLETED` from the library's own
manifest, which is all a scheduled local notification needs.

If real push is ever built, that plugin entry is part of it, and so is a paid Apple account.

## What is left: real push, and what it would take

The one gap is an approval reaching a device with the app **killed**. Closing it is not a client change:

- **A sender that is always awake.** The hub is the only such component, and it is trusted with nothing, including
  who sent something. Subscription endpoints are device-identifying URLs, so holding them is a new thing to trust it
  with, and whether they go there or are relayed to a runtime inside a seal is the design question.
- **Web Push**: a VAPID key pair, a subscription per device, and outbound HTTPS from the sender. The payload rule
  helps here: a push with **no payload** is legal, and the service worker's `push` handler can say "an approval is
  waiting" out of its own code, so RFC 8291 content encryption is not needed at all.
- **Android**: an FCM project and its service-account credentials, which are an account decision rather than a code
  one. Nothing in this repo can create them.
- **iOS**: a paid Apple account, for the entitlement above. Web Push on iOS works only for a home-screen-installed
  web app (16.4+), which the hosted client is.

Until then the badge is honest while the app runs and stale while it does not, and the certificate, which is the
deadline that actually matters, does not depend on any of it.

## Why these are a backstop and not the mechanism (auto-renew, 2026-10-04)

A certificate is issued for 90 days (`MAX_CERTIFICATE_MS`), and a renewal is refused outside the last 14
(`RENEW_WITHIN_MS`). Renewal is only ever a button press: `renewSelf` has exactly one caller, the inbox's `apply`.

So what the product asks of a person today is to **open the app and press Renew inside one particular fortnight every
90 days**. These reminders exist to make that ask survivable, and on the phone they do. They cannot make it a good
ask.

**So auto-renew on connect was built** (`src/chat/auto-renew.ts`). A device that connects at all inside the renewal
window renews itself silently: the same operation as the press, the same subject, scopes, role and `mayPair`, with
only the window moving. The hub's gate already constrains it to self-only, inside 14 days, with a cooldown, so
nothing new is trusted, and `may_revoke` holders and delegate-issued certificates stay excluded exactly as before.

It lives in the PAGE half, so the hosted client and the phone (whose page is the same client in a WebView) are served
by one implementation, and **the phone needed no Renew button at all** — which matters, because before this it had
no renewal path whatsoever: `renewSelf` was composed only in `client.tsx`, so the phone's inbox said renewing was not
something that screen could do and sent people to pair again.

**A failure is silent, deliberately.** Nobody asked for it, so nothing may interrupt them about it; it degrades to
the inbox item and its button, which is the visible path that already says why. The one thing worse than a renewal
that did not happen is a dialog about a renewal nobody requested.

It also makes the web's one real limitation stop mattering for the certificate: opening the installed client once a
month keeps it current, whether or not a notification could have reached it while closed.

Two doc comments already described this world before it existed, which is why it reads as intent rather than as a new
idea: `attention.ts` ("a device that keeps connecting keeps itself current, so the only signal left is a person being
told") and `DeviceInfo.lastSeenMs` ("a runtime renews everything on its allowlist").

### What auto-renew cannot reach: the revocation signer

`defaultGrant` (`src/hub/pair-flow.ts`) gives EVERY runtime `mayRevoke: true`, and `device.renew` refuses a
`may_revoke` certificate outright, so on today's defaults no browser can renew itself at all. That is not a design
choice to work around here, it is the code disagreeing with window-ml-hub `docs/design/revocation.md`, which says
`may_revoke` is "held by exactly one principal at a time" and that "a second runtime that may revoke is the root's
decision to re-place, not a default".

The expiry cliff is the milder symptom. The worse one is that `src/hub/runtime/hub-devices.ts` signs with
`version = Math.max(nowMs, this.state.version + 1)` where `this.state.version` is each runtime's OWN stored state, so
two signers race and the one whose state or clock trails the other has its list refused as stale: a removal of a lost
device can silently fail, which that doc names as the worst possible way for a revocation to fail.

Handed to the hub session and settled: window-ml-hub #60 records the first principal to log in holding `may_revoke`
and refuses a different one its login, and #61 reports that record in the `Welcome` as the signer's CERTIFICATE. Our
half shipped as one signer per account chosen where somebody is standing, plus `readRevoker` (`src/hub/revocation.ts`).

**The record is VERIFIED, never believed**, and the asymmetry is why it carries a certificate rather than a principal
id. A hub HIDING a signer it has is safe: the grant is offered to another device, which is refused at its own login,
in front of whoever is pairing it. A hub CLAIMING one that does not exist is not: a client would default the grant
off, the account would never grant it, no list would ever be published, and nothing would say so. `may_revoke` is
never delegable, so the certificate is root-signed, and a hub that invents a signer has to forge a root signature.

**ABSENT ALONE IS NOT "NONE", and the fix was a feature NAME rather than a protocol major.** An absent `revoker` is
the same bytes from a hub that holds no signer and from one too old to keep the record, and #61 bumped no protocol
major, so for one version the two were a single answer to a reader. window-ml-hub v0.4.3 adds `Welcome.features`, a
list of the optional behaviours a hub implements, carrying `"revoker"`: only a hub that announces the name is saying
anything by omitting the certificate. The protocol major deliberately did NOT move, because `Hub::connect` refuses a
hello below its own, so a major locks every older client out at the hub's next restart; announcing an optional
behaviour is expressible additively, and this is what that looks like.

So `readRevoker` answers three things rather than two, and the third is the only one anything may warn on:

| hub | `features` | `revoker` | answer |
| --- | --- | --- | --- |
| before v0.4.2 | `[]` | absent | `unknown` |
| v0.4.2 | `[]` | either | `signer` where one verifies, else `unknown` |
| v0.4.3 | `["revoker"]` | present | `signer` where it verifies, else `unknown` |
| v0.4.3 | `["revoker"]` | absent | `none` |

A PRESENT CERTIFICATE THAT DOES NOT VERIFY IS `unknown`, NEVER `none`, even from a hub announcing the name. That is a
lying or broken hub, and reading it as "the account has none" would let one manufacture the warning with a few bad
bytes. The name is tested for BY NAME, never by position: the list is the server's own and additive, so a fork may
add its own and an unknown name is not an error.

**What it unblocked: the "no device can remove another from this account" inbox item** (`revokerItems`,
src/chat/attention.ts), on the page and on the phone. Its subject is that no device CURRENTLY holds the grant, not
that the account can never revoke, because the root can grant it to one and that is what the item points at. It is a
`limits` rather than a `blocks`: every removal still takes effect on the runtime you make it on, which is exactly why
it needs saying — the obvious check looks like it worked, while `publishList` returns early without the grant and
every other runtime and the box connector go on trusting the removed device.

The bound on believing it, which is the hub session's own reasoning and worth keeping: a hub can withhold the feature,
which yields `unknown` and no warning; or announce it and withhold a certificate that exists, which yields a FALSE
warning whose prompted action — granting `may_revoke` to another device — is then refused at that device's own login,
loudly, in front of whoever is pairing it. So the worst case is a confusing loop rather than a silent loss, and every
action the warning prompts is independently checked. The direction that would have been irresponsible is the opposite
one, a hub asserting a signer where none exists, and that is unreachable here because the field carries a root-signed
certificate.

The older-hub case is a DECODE SHAPE rather than a deployment: the rule is a pure function of `(features, revoker)`,
so all four rows are asserted with no hub at all (`tests/hub-revocation.test.mjs`), which is what proves no warning
fires against v0.4.2. One live test covers the two v0.4.3 rows against the real binary
(`tests/hub-runtime.test.mjs`), where the name has to actually arrive and the certificate has to actually verify.

**Both halves of it are encoded as tests rather than left as prose** (`tests/auto-renew.test.mjs`, the last section).
They take `defaultGrant` and `autoRenewSkip` as their oracle rather than a copy of the reasoning, so they cannot drift
from the code:

- Each role's renewal path, with the set of roles that have NONE pinned to exactly `["ROLE_RUNTIME"]`. It was checked
  by applying the fix and watching it go red, so it is a guard rather than a test that happens to pass. It also fails
  if a NEW role arrives that cannot stay in the account, which is the regression it is really there for.
- The two-signer race, demonstrated: two `DeviceRegistry` instances sign, the second with a clock one second behind,
  and its version is not above the first's, so a publisher holding the first refuses it.
- That the inbox never offers a renewal the runtime would refuse (`CERT_WARN_MS <= RENEW_WITHIN_MS`). If the warning
  were ever the wider of the two, a press in the gap would be answered "not due", which `renewSelf` reports as a
  success with nothing installed, so the card would say nothing and leave the warning up: the dead-button failure
  of #323 arriving by another route.

## Tests

`tests/reminders.test.mjs` is the rule: the schedule at every threshold, what each line says on each branch, that a
past threshold is skipped, that a live reading cannot reach a plan, the replan after a renewal, and the hosted
client's timer over a stubbed `Notification` and storage. `tests/native-bridge.test.mjs` checks that the plan crosses
to the app and that a malformed one is dropped whole. `tests/mobile/notify-settings.yaml` is the phone's row. `tests/auto-renew.test.mjs` is the renewal policy and its
driver: which conditions earn an attempt, which rule refuses and in which order, that a renewal in flight is never
started twice, and that a failure is silent.
