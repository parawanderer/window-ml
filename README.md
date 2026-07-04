# window.ml

Personal Chrome extension that exposes a scripting API (`window.ml`) on web
pages, bridging them to local LLMs served by [OpenWebUI](https://openwebui.com)
/ [Ollama](https://ollama.com). Built as devtools-console glue: the deliverable
is a `window.ml` object you call from any page's console (or from page scripts),
not a chat UI.

> Honest provenance: this is personal, largely AI-generated glue code, shared
> so the next person wanting a console-first LLM bridge doesn't have to build
> it from scratch. It works (and has tests), but there's no roadmap and no
> support — fork freely. MIT licensed.

```js
await ml.chat("Summarize this page's title: " + document.title);

// Multimodal — pass literal <img> DOM nodes:
await ml.chat("What's in this image?", { images: [document.images[0]] });

// Multi-turn:
const h = ml.createChat({ system: "Be terse." });
await h.chat("What is a monad?");
await h.chat("Now explain it like I'm five");
```

## Setup

1. `chrome://extensions` → Developer mode → **Load unpacked** → this directory.
2. Recommended: set the extension's **Site access** to **On click**, so
   `window.ml` only exists on pages where you've clicked the extension icon.
3. Open the popup (extension icon):
   - **Chat completions URL** — e.g. `http://localhost:3000/api/chat/completions`
   - **API key** — OpenWebUI → Settings → Account → API keys
   - **Model** — hit **Load** to pick from the server's list
   - **API format** — must match the URL (see table below)
   - **Save & Test** sends a real prompt and shows the extracted reply.

### Endpoint / format cheatsheet

| URL | API format | Notes |
| --- | --- | --- |
| `<host>/api/chat/completions` | OpenAI | OpenWebUI's external API. Broken on OpenWebUI 0.9.5 ([#24550](https://github.com/open-webui/open-webui/issues/24550)), fixed by 0.10.x. |
| `<host>/ollama/api/chat` | Ollama native | OpenWebUI's raw Ollama passthrough (same bearer key). Bypasses OpenWebUI middleware; needs raw Ollama model names. |
| `http://ollama-host:11434/api/chat` | Ollama native | Direct Ollama, no OpenWebUI. |

There is **no** root-level `/v1/chat/completions` on OpenWebUI (tested 0.9.5
and 0.10.2) — unknown routes return the frontend HTML page.

## `window.ml` API

| Call | Purpose |
| --- | --- |
| `ml.chat(prompt, options?)` | One-shot chat. Returns the reply text. |
| `ml.chatShort(prompt, options?)` | Same, with a brevity suffix. |
| `ml.createChat(options?)` | Multi-turn history object (below). |
| `ml.models()` | Available model ids on the server. |
| `ml.getModel()` / `ml.setModel(id)` | Read / persistently switch the default model. `setModel` validates against the server list and syncs the popup. |
| `ml.ps()` | Models loaded in VRAM: `[{ model, vramGB, expiresAt }]`. |
| `ml.unload(model?)` | Evict a model from VRAM (`keep_alive: 0`); no argument = evict all. |
| `ml.read(imageOrUrl)` | OCR via the (optional) OCR server. |
| `ml.logChat` / `ml.logChatShort` | `console.log` variants. |

Options (all optional, both for `chat` and `createChat`):

- `system` — system prompt.
- `model` — model override; doesn't touch the saved default.
- `think` — `true`/`false` maps to Ollama's native thinking toggle; `null`
  omits it (server default). Models that support thinking are asked not to
  by default. Sending images to a model without vision capability fails fast
  with a clear error (checked via `/api/show`).
- `cleanup` — strip `<think>…</think>` from replies (default on).
- `images` — (per-call) list of `<img>` elements and/or URL strings.

### History objects

```js
const h = ml.createChat({ system, model, think, cleanup });
await h.chat("prompt", { images, model, think, cleanup });  // per-turn overrides

h.messages          // plain [{ role, content, images? }] array — edit freely:
h.messages.at(-1)   //   last message
h.messages.pop()    //   drop a turn to retry
h.fork()            // independent deep copy of the conversation
```

Design invariants: assistant replies are stored post-cleanup (thinking blocks
are never resent as context) and a failed request leaves `messages` untouched.

## Architecture

| File | Role |
| --- | --- |
| `injected.js` | Runs in the page's main world; defines `window.ml`. Serializes `<img>`/blob/http images to data URLs. |
| `content.js` | Dumb relay: `window.postMessage` ⇄ `chrome.runtime.sendMessage`. |
| `background.js` | Service worker. Owns config, builds per-format request bodies, extracts replies, talks to OpenWebUI/Ollama (CORS-free). |
| `popup.html/js` | Settings UI (`chrome.storage.sync`), model picker, Save & Test, Free VRAM. |

Security note: config overrides (URL/key) are only accepted from the popup —
messages relayed from web pages (`sender.tab` set) cannot repoint the saved
API key at another host, and pages can only ever change the model (validated).

## Tests

```sh
npm test
```

No dependencies — Node's built-in `node:test` runner (Node ≥ 20). Since the
extension files are plain scripts, not modules, `tests/helpers.js` loads them
into `node:vm` sandboxes with mocked `chrome`/`fetch`/`window` globals, so the
tests exercise the exact files Chrome runs:

- `tests/background.test.js` — the service-worker message contract: request
  building per API format, response extraction, error messages, model
  validation, vision fail-fast, VRAM unload, and the popup-only-overrides
  security property.
- `tests/relay.test.js` — `injected.js` + `content.js` wired together in a
  fake page world; exercises the real postMessage round trip, history
  semantics, fork, and image conversion.
- `tests/live.test.js` — **opt-in** checks against a real server, validating
  the route/capability assumptions everything else relies on:

  ```sh
  OPENWEBUI_URL=http://localhost:3000 OPENWEBUI_KEY=sk-... npm test
  ```

  The chat round-trip test additionally requires `OPENWEBUI_MODEL=<id>` so a
  test run never surprise-loads a huge model into VRAM.

### VSCode test runner

VSCode has no built-in `node:test` support; install the
**[nodejs-testing](https://marketplace.visualstudio.com/items?itemName=connor4312.nodejs-testing)**
extension (`connor4312.nodejs-testing`) and the suite appears in the Testing
sidebar with per-test run/debug, picked up automatically from the `*.test.js`
naming. For quick breakpoint debugging without any extension: open a
**JavaScript Debug Terminal** (command palette) and run `npm test` in it —
breakpoints in both tests and extension source bind through the `vm` loader.
