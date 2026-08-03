# Spec: enforce privileged-op consent at the BACKGROUND choke point

Status: **planned** (holes demonstrated, fix not yet landed). Two `todo` tests in
`tests/background.test.js` (`SECURITY (FETCH_SHEET)` / `SECURITY (PYTHON_EXEC)`)
encode the desired behavior and **fail today**; dropping their `todo` flag is the
acceptance gate.

## The holes (both demonstrated by the `todo` tests)

Two privileged background handlers can be driven **directly by any web page**
through the content-script relay, and their consent gate lives only in the
**client-side agent loop** — which, because `injected.ts` runs in the page's main
world, is trivially bypassable (write your own loop, or just post the raw
message). The handlers enforce nothing per-call.

1. **`FETCH_SHEET`** ([background.ts](../../background.ts)) is `credentials:"include"`
   (the user's Google cookies) and host-locked to `SHEET_URL_OK`
   (`docs.google.com/spreadsheets/d/<id>/export?…`). The host-lock stops a
   *general* SSRF/"read any URL credentialed", but the `<id>` is **page-controlled**
   — so a hostile page that knows a private sheet's id **exfiltrates its contents
   with the user's session, unapproved**. Bounded (Google Sheets only, id is an
   unguessable ~44-char random → a *targeted* read, not a blind sweep) but a real
   consent bypass. `FETCH_SHEET_TITLE` similarly leaks a sheet's *title* by id.

2. **`PYTHON_EXEC`** takes `hardened` straight from the message. `hardened:false`
   (full mode) leaves the js/network bridge intact, and the offscreen worker runs
   at the **extension origin** (`<all_urls>` host permission) — so its fetch/XHR
   **bypass CORS** and can be **credentialed** (`js.fetch(url,{credentials:'include'})`).
   That is *strictly more powerful than any other tool*: unlimited credentialed
   cross-origin reads. "Full mode requires approval" is enforced **only** in the
   bypassable loop.

`FETCH_LLM` (page can only pick a validated/filtered model; url/key come from
storage) and `FETCH_IMAGE_B64` (**uncredentialed** → public cross-origin bytes,
never the user's authenticated data) are *safe by construction* and out of scope.

## Root cause + why a blanket block won't do

Consent is asserted client-side, and the choke point trusts the message. The
naive fix — "refuse when `sender.tab` is set" — is wrong because the **legitimate
design-A agent path also relays these from the page** (`RUN_TOOL_IN_PAGE` runs the
tool in the page, which calls `ml.pythonExec` / `FETCH_SHEET`): `sender.tab` is set
for both the approved agent run and a hostile page, so a blanket block breaks the
agent's own external-sheet / network-python features.

So consent must be enforced **at the background choke point with an unforgeable
signal**, while still admitting the approved agent path.

## The rule: a privileged call FAILS unless one of three things is true

`sender` is set by the browser, not the message; a page cannot forge it, and can
only reach the background *through* the content script (which stamps `sender.tab`).
A privileged call (`FETCH_SHEET`, or `PYTHON_EXEC` with `hardened:false`) is
**refused** unless:

1. **Trusted surface** — `sender.tab == null` (popup / offscreen / devtools / a
   future debug REPL). Internal extension code; allow.
2. **Whitelisted domain** — `sender.tab` set, origin ∈ `config.### 2. The handler guards

Each first computes `senderTrust(sender)`; `surface` and `whitelisted` always pass.
A refused privileged call **throws a clear authorization error** — never a silent
downgrade (that would surprise the caller/model with a confusing later failure, and
is harder to handle than an explicit `Error: this call needs approval / a
whitelisted origin`).

- **`FETCH_SHEET`** — derive `id = googleSheetId(url)`. For `untrusted`: allow **iff**
  `pendingGrants` has `(tabId,"sheet",id)` → consume; else **reject** with an
  actionable error, and **never** send `credentials:"include"` on the refused path.
- **`PYTHON_EXEC`** — `hardened:true` (readonly) always allowed (network nulled).
  `hardened:false` for `untrusted`: allow **iff** `pendingGrants` has
  `(tabId,"pyfull",hash(args))` → consume; else **reject** with the authorization
  error (do NOT run readonly-behind-their-back). This keeps agent full-mode python
  working on untrusted origins (it got a grant) while a raw page call is refused.
- **`FETCH_SHEET_TITLE`** — **internal-only.** It isn't even in the content-script
  relay (`content.ts` HANDLE_MAP), so a page can't reach it today; it exists solely
  for the approval card (an extension-origin iframe → `sender.tab == null`) to show
  the sheet name. Enforce that: **refuse any call with `sender.tab != null`.**
  (Defense in depth — a future relay entry or a spoofed direct message stays inert.)

### 2a. `FETCH_IMAGE_B64` — bound the SSRF/cross-origin read (no grant)

Not approval-gated (it's a free, high-frequency core op — `window.ml` serialises
page images through it), so it can't use the grant model. But it's `fetch(url)` at
the extension origin: **uncredentialed** (so never the user's authenticated data —
the important bound), yet still a "read any URL's bytes" primitive → **SSRF to
internal hosts** and CORS-bypassing reads of public resources. Fence it structurally,
like `FETCH_SHEET`'s host-lock but as a **denylist**:

- **Refuse private / loopback / link-local / metadata targets** — `127.0.0.0/8`,
  `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (+ `::1`, `fc00::/7`, `fe80::/10`),
  `localhost`, and non-`http(s)` schemes. Kills the internal-network probe/read.
- Keep it **uncredentialed** (already true — assert `credentials` stays default).
- Optional: require the response `content-type` to be `image/*` (it's an *image*
  tool) so it can't be repurposed to read arbitrary public text/JSON. Weigh against
  servers that mislabel images.

Residual after this: "read *public* internet bytes, uncredentialed" — acceptable
(public data, no auth, no internal reach).

### 3. The invariant this restatespageApprovalDomains`.
   The user has explicitly trusted this domain to self-gate, so it may call
   privileged tools directly (and write its own approval loop that never routes
   through the extension). **Not the default.**
3. **Iframe-approved FOR THIS CALL** — the call was routed through the extension's
   design-A agent loop, which raised an approval in the (unforgeable, extension-
   origin) iframe, and the user approved it. That approval authorizes **exactly
   this one call**. It is **one-time**: consumed on use. A *subsequent* call — even
   for the same resource — is not automatically allowed; it needs its own approval.

Concept 3 is the crux, and the piece the first draft got wrong (it granted a
sheet *persistently*). The **iframe approval is the authorization** — per-call,
one-time, unforgeable — sitting alongside the blanket domain whitelist, not
replacing it.

## Design

### 0. Shared helper (`background.ts`)

```ts
async function senderTrust(sender): Promise<"surface" | "whitelisted" | "untrusted"> {
    if (sender.tab == null) return "surface";
    const cfg = await getConfig();
    const host = (() => { try { return new URL(sender.tab.url || sender.url || "").hostname; } catch { return ""; } })();
    return host && (cfg.pageApprovalDomains || []).includes(host) ? "whitelisted" : "untrusted";
}
```
This is the exact origin-derivation `GET_CONFIG` already does for
`pageApprovalAllowed` (background.ts ~L1001) — factor that out and reuse it.

### 1. One-time per-call grants (the mechanism for concept 3)

A single background-side registry, **not** a persistent per-resource set:

```ts
// A privileged sub-op the design-A loop APPROVED for a specific tab, awaiting its one use.
// key = `${tabId}:${kind}:${resourceId}` — kind ∈ "sheet" | "pyfull"; consumed on the matching call.
const pendingGrants = new Set<string>();
const grantKey = (tabId, kind, resourceId) => `${tabId}:${kind}:${resourceId}`;
```

- **Mint (at approval time).** In the design-A loop's `approve` path (background.ts
  `START_RUN`), *after* the user approves a tool call, for each privileged sub-op it
  will trigger, add a grant keyed by `(tabId, kind, resourceId)`:
  - a `python_exec` that loads external sheets → one `sheet` grant per
    `externalSheetIds(args)` (the sheet id);
  - a `python_exec` with `mode:"full"` → one `pyfull` grant for **`hash(args)`** — the
    canonical hash of the *whole* tool-args object, **not** just `code`. The args are
    `{code, image, tables, mode, cast, margin, tableRaw}`; the data bindings (`image`,
    `tables`) are part of what the user approved. Hashing `code` alone would let an
    attacker keep the approved code but **swap the `tables`/`image` binding** to a
    different sheet/selector and reuse the grant to process different data.

  This is the *unforgeable* signal: a key only lands here via a real `SET_APPROVAL`
  from the extension iframe, bound to what the card actually showed the user (the
  sheet **name** / the full args). A hostile page can't mint one, and can't repurpose
  a grant for a *different* resource (different key). One-time ⇒ consumed on use, so a
  subsequent call needs its own grant.
- **Threading, or lack thereof.** No token is passed through the page — the
  background *records its own approvals*, and matches the incoming call by
  `(sender.tab.id, kind, resourceId)`. Even a hostile page on the same tab can at
  most consume the grant for the operation *the user just approved* (bound to that
  resource, one-time) — which is exactly the consent given. No escalation.
- **UX cache is orthogonal.** The existing "external sheet approved → skip the
  re-prompt this page-session" cache stays a *prompt* policy: a cached decision lets
  the loop **auto-mint** a fresh grant without re-asking. Security is per-call (a
  grant every time); the cache only decides whether the human is re-prompted.



Gate privilege at the background choke point, **never** at the (bypassable) agent
approval. `requiresApproval` stays pure UX consent; the *boundary* is here. See
[[principle-adding-a-privileged-tool]], [[decision-pythonexec-not-a-page-primitive]].

## In scope, per op

- `FETCH_SHEET` — one-time `sheet` grant (§1–2).
- `PYTHON_EXEC` full — one-time `pyfull` grant keyed by `hash(args)` (§1–2).
- `FETCH_SHEET_TITLE` — internal-only, refuse `sender.tab != null` (§2).
- `FETCH_IMAGE_B64` — SSRF denylist + uncredentialed + optional image-only (§2a).

## Accepted (out of scope)

- `FETCH_LLM` — a page calling the configured model is the point of the extension;
  url/key are storage-only, model is validated + `modelFilter`ed.
- `CAPTURE_TAB` — own-tab only (`sender.tab.windowId`).
- Agent full-mode python on an untrusted origin is **preserved** — it flows through
  a `pyfull` grant. Only *raw, unapproved* page calls are refused.

## Testing (acceptance)

- Flip the two `SECURITY (…)` `todo` tests to real tests (drop `todo`) — untrusted
  page, no grant → sheet refused / full-python **rejected with an auth error**.
- Add these as `todo` now (they need `senderTrust` + a `pendingGrants` test hook to
  mint a grant, so they can't run until the mechanism lands — but capture the intent):
  - trusted surface (`sender.tab` undefined) → full python + sheet allowed.
  - whitelisted origin (`pageApprovalDomains: ["good.example"]`) → allowed.
  - untrusted page **with a matching grant minted** → that one call allowed, the grant
    is **consumed** (a second identical call refused), and a call whose args differ
    (swapped `tables`/`image`, or a different sheet id) is refused.
  - `FETCH_SHEET_TITLE` from a page (`sender.tab` set) → refused; from a surface → ok.
  - `FETCH_IMAGE_B64` to `http://169.254.169.254/…` / `http://localhost/…` → refused;
    to a public https image → allowed and uncredentialed.
