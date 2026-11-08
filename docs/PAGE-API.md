# The page API: what a site gets of `window.ml`

[API.md](API.md) lists every member of `window.ml`. This page is about who may call them: what a website's own scripts
get, how that depends on what the person allowed the site, and how a page asks for more. The rules behind it are
[spec/SITE_ACCESS.md](spec/SITE_ACCESS.md) and [spec/SITE_PRESENCE.md](spec/SITE_PRESENCE.md); the implementation is
[dev/site-access.md](dev/site-access.md).

## Who is calling

The extension judges a call by the page it came from, as the browser reports it, never by anything the page says. So
the person typing in the DevTools console and the site's own scripts are the same caller: both run in the page's main
world, and both get exactly what the site is allowed.

| Caller | Seen as | Gets |
| --- | --- | --- |
| The site's own scripts | the page's origin | what the site is allowed (below) |
| You, in the DevTools console on that page | the page's origin | the same: the console is the page |
| A userscript in the page's world (Tampermonkey, *User JavaScript and CSS*) | the page's origin | the same |
| A userscript in an isolated world | nothing | no `window.ml`; bridge with `window.postMessage` |
| A run you start (the HUD, the sidebar, the chat page) | the extension | works on any page, allowed or not; each gated tool asks you |
| The model, in a run the site started in the worker (`ml.agent`) | the run | the run's tools, each gated tool asking you; the site's turns are marked as the site's |
| An extension page (Settings, the panel) | the extension | the trusted surface; not a page caller |

The split that matters is between the page API (everything a page calls, under its site's access) and the run you
start yourself. Your run is built by the extension, so the page it works on is lent nothing: no `window.ml` appears
there because of it, and on a page that may not use `window.ml` its tools run out of the page's reach. `ml.current` and
`ml.sh` exist only in a script you approved inside a run the extension hosts: the one you start, or one the site started
in the worker. A page's own `window.ml` never has them, and neither does a run with `host: "page"`.

## What a site gets, by its access

A site is one origin: `http://` and `https://`, and every port, are separate decisions.

| Site's access | `window.ml` in the page | What the page can do |
| --- | --- | --- |
| Not allowed (the default), or denied | absent | nothing: no script of ours, no message, no answer. A denied site and an unknown one look the same |
| Not allowed, but may ask ("Let it ask" for the site, or "Let sites ask for access" for every site) | `{ requestAccess }` only | ask to use `window.ml` |
| Allowed, for the browser session or always | the full API | every member, each under the rules below; ask for agents or self-approval |
| Allowed, with agents at Ask each time or Always | the full API | also start agents in the worker (`ml.agent`, `ml.createAgent`, `ml.resumeAgent`) |
| Allowed, and listed under "Sites that approve their own actions" | the full API | also answer its own approval prompts: the strongest grant, for a site you control |

A newly allowed site starts with agents Off. The person sets every level in DevTools Settings → Permissions; the popup
sets whether a site is allowed.

## Waiting for `window.ml`

On an allowed site `window.ml.ready` is a promise of `ml`, and `ml:ready` fires once the API is in the page. The ask
stub has neither, and a site that is not allowed has no `window.ml` at all, so a script that only waits for
`ml:ready` waits forever there. Check what is present first:

```js
if (window.ml?.ready) {
    const ml = await window.ml.ready;              // allowed: the full API
} else if (window.ml?.requestAccess) {
    // may ask: request access on a click (below); `ml:ready` fires if the person allows it
} else {
    // not allowed, or not loaded yet: `ml:ready` fires if the person allows the site while the page is open
}
```

When the person allows a site whose page is open, the extension puts the full API into that page, replacing the stub,
and fires `ml:ready`.

## Asking for access

```js
button.addEventListener("click", async () => {
    const answer = await window.ml.requestAccess({ reason: "Summarise the articles you open here" });
});
```

- `requestAccess({ reason })` on a site that may ask: to use `window.ml`.
- `requestAccess({ agents: true, reason })` on an allowed site: to start agents.
- `requestAccess({ level: "self-approve", reason })` on an allowed site: to approve its own actions.

The call needs a click or key press on the page just before it, and only a top-level `http(s)` page may ask. The
request waits in the toolbar button's badge and popup, and in DevTools Settings, until the person answers; nothing
opens by itself. `reason` is shown as the site's own words.

It never throws. It resolves with one of:

| Answer | Meaning |
| --- | --- |
| `{ state: "granted", agents }` | the site has what it asked for; `agents` is its agent level now |
| `{ state: "pending" }` | the request is waiting for the person |
| `{ state: "denied" }` | the person said no |
| `{ state: "refused", reason }` | the request was not taken; `reason` says why |

The `reason` of a refusal is one of: `needs a user gesture`, `only a page's top frame on http or https can ask`, `too
many requests are waiting; try again later`, `this browser does not take requests from sites`, `ask for access first`
(asking for self-approval before the site is allowed), `this page was opened by a running agent`.

## What an allowed page can call

Free, with no prompt: the model calls (`chat`, `createChat` and `resumeChat` for sessions that survive a reload, `step`,
`embed`, `read`), the
model and server readouts (`models`, `getModel`, `setModel`, `config`, `info`, `ps`, `capabilities`, `unload`,
`serverTools`), `screenshot` of its own tab, and the client-side helpers (`schema`, `defineTool`,
`pipe`, `jsonPath` and the rest). `config()` is the non-secret subset: never the server URL or the key. `setModel`
takes only a model the server lists.

Under rules of their own:

- `ml.fetch` reads the page's own origin freely, with or without cookies and rendered, and, without cookies and not
  rendered, the extension's own published source (a setting, on by default). Without cookies, any other URL needs the person's approval for this
  tab in a run, or to be spelled out in a script the person approved. With cookies, any other URL needs a per-URL
  approval of `fetch_url` in a run; an approved script cannot supply it. A redirect is followed one hop at a time, and
  only to the same site, from http to https on the same host, or to a URL the person already approved; any other hop
  is refused before its target is requested, and the page is told only that it led to another site. An approved
  script's own redirects are trusted. Only
  `http(s)` URLs, never a local file. A site that approves its own actions is refused none of this.
- `ml.agent`, `ml.createAgent` and `ml.resumeAgent` need the site's agent level. At Ask each time the person sees a
  card with the site's task in its own words, and nothing runs until they allow it; the model reads every turn the site
  sends as the site's, never as the person's. A page may always cancel its own run. `ml.agent({ host: "page" })` runs
  the loop in the page instead, which is plain `window.ml` use: no agent level needed, and no server tools.
- `pythonExec`, a Google Sheet read, `execServerTool` and a reserved-element click are refused as direct page calls.
  They run through a run's tool that the person approves, or on a site that approves its own actions.

The page owns its world. An allowed page can override `window.confirm`, forge the page-side messages, or put
instructions into what an agent reads, so the approval prompts protect the person from the model, not from a hostile
page they allowed. What the extension guarantees on every page: the server URL, the key and the model filter never
reach a page, and every privileged call is judged by the worker on the page's origin. Allow only sites you trust.

## The refusals a page sees

An error a page receives has the server URL, the API key and the model filter removed; if that cannot be checked, the
page gets only `The request failed.`

| When | Text |
| --- | --- |
| The site is not allowed | `Refused: <origin> is not approved to use window.ml. Allow it from the extension's toolbar button.` |
| The site is denied | `Refused: <origin> is not allowed to use window.ml.` |
| `ml.agent` without the agent level | ``Refused: <origin> may use window.ml but not start agents. Pass `host: "page"` to run the loop in the page, or ask with `ml.requestAccess({ agents: true })`.`` |
| Agents denied for the site | `Refused: <origin> is not allowed to start agents.` |
| The person declined the start card | `Refused: the person declined to start this agent. Nothing ran.` |
| `ml.fetch` of another origin | `Refused: "<url>" hasn't been approved for fetching on this page. ...` |
| `pythonExec`, read-only code | `Refused: Python from a page needs approval on this page. ...` |
| `pythonExec`, any other code | `Refused: Python outside the read-only dialect needs approval on this page. ...` |

A page that is not allowed normally sees neither of the first two: no `window.ml` is there to call. They reach a page
that kept its `window.ml` while the person changed the site's access.
