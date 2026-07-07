# Examples

## YouTube video summarizer — [`youtube-summarizer.user.js`](./youtube-summarizer.user.js)

![A screenshot showing youtube with the youtube-summarizer.user.js user script enabled](../docs/youtube-summarizer-2026-07-06_21-26.png)

A page-context userscript that injects an **AI Summary** card into the YouTube
watch page. It uses [`window.ml`](../README.md) to call an OpenWebUI **server-side
transcript tool**, summarizes the video, and lets you ask follow-up questions —
all inside the page, grounded in the actual transcript.

### What you get

- A themed panel in the right rail (light/dark aware) that survives YouTube's
  in-app navigation between videos.
- **✨ Summarize this video** → a compact, consistent TL;DR + key points, **streamed
  token-by-token** into the panel (via `onToken`), then finalized as formatted markdown.
- A follow-up box to chat about the video (the transcript tool stays available,
  so answers stay grounded). It can also reach for OpenWebUI's **built-in web
  search** to answer questions beyond the transcript — more about the
  channel/creator, related facts — when a follow-up needs it.
- A **model dropdown** in the header, populated from `ml.models()`. Defaults to
  `qwen3:32b`; pick any model on your server.
- A **⚠️ warning badge** (hover for details) when the selected model isn't
  available on your server, or doesn't advertise tool-calling support — the two
  things that stop the transcript tool from working.

---

### Prerequisites

1. **OpenWebUI** as your backend — server-side tool calling is an OpenWebUI
   feature (the plain Ollama endpoint can't do it).
2. **The window.ml extension installed and enabled on `youtube.com`.** Set its
   Site access so it runs on YouTube (otherwise `window.ml` won't exist on the
   page and the panel will show a "window.ml not detected" badge).
3. **A tool-capable model pulled in OpenWebUI** — e.g. `qwen3:32b`, or any model
   whose Ollama capabilities include `tools`. (The panel's badge flags models
   that don't.)
4. **The YouTube transcript tool registered in OpenWebUI**, at
   `http://<openwebui>/workspace/tools`. Install it from
   [openwebui.com](https://openwebui.com/posts/youtube_transcript_provider_update_2122025_a2863c56).
   If that link dies, create a new Tool and paste
   [`youtube_transcript_provider_update_2_12_2025.py`](./youtube_transcript_provider_update_2_12_2025.py)
   as the source, with `youtube_transcript_provider_update_2_12_2025` as the **ID**.
5. **(Optional) Web Search enabled in OpenWebUI** (Admin → Settings → Web Search,
   with a provider like SearXNG / Google PSE). Lets follow-ups answer questions
   beyond the transcript. Set `WEB_SEARCH_TOOL_ID = ""` in the script to skip it.

### Install

Use the **[User JavaScript and CSS](https://chromewebstore.google.com/detail/user-javascript-and-css/nbhcbdghjpllgmfilhnhkllmkecfmpld?hl=en)**
extension: add a rule for `https://www.youtube.com/*`, paste the contents of
[`youtube-summarizer.user.js`](./youtube-summarizer.user.js), and enable it on
`youtube.com`. Open any video — the card appears in the right rail.

> **Why not Tampermonkey?** It *should* work (it runs in the page's main world,
> which is what `window.ml` needs), but on some setups its internal messaging
> breaks on YouTube (`content.js … Cannot read properties of undefined (reading
> 'addListener')`) and the panel never loads. User JavaScript and CSS is the
> tested host here. See the troubleshooting table.

### Configuration

The model is selectable at runtime from the header dropdown. To change the
**default** model or the transcript tool, edit the top of the script:

```js
const DEFAULT_MODEL      = "qwen3:32b";                             // pre-selected model
const TRANSCRIPT_TOOL_ID = "youtube_transcript_provider_update_2_12_2025"; // OpenWebUI tool *id*
const TRANSCRIPT_FN      = "get_youtube_transcript";               // the tool's *function* name
const WEB_SEARCH_TOOL_ID = "web_search";                           // OpenWebUI built-in web search ("" to disable)
```

> **Tool id vs. function name** — these are two different things and both matter.
> `TRANSCRIPT_TOOL_ID` is what *enables* the tool server-side (`tool_ids`).
> `TRANSCRIPT_FN` is the function name the model actually *calls*, and it's named
> in the prompt so the model reliably invokes it. If you swap the tool, update
> both.

---

### Troubleshooting & edge cases

| Symptom | Cause | Fix |
| --- | --- | --- |
| **Panel never appears** | The userscript isn't running in the page's main world, or `window.ml` isn't present. | Use **User JavaScript and CSS** (not Tampermonkey) and make sure the window.ml extension has Site access on `youtube.com`. In the console, `typeof window.ml` should be `"object"`. |
| **"window.ml not detected" badge** | The window.ml extension isn't active on this page. | Click the extension icon / enable Site access for `youtube.com`, then reload. |
| **Summary bubble is empty / nothing inserts** (but the GPU spins up) | OpenWebUI handed back an *unexecuted* tool call (`content: ""`, `finish_reason: "tool_calls"`) instead of running the tool. This happens in **Native** function-calling mode — the tool's code lives on the server, so the page can't run it. | The extension now auto-forces the server-side execution loop (`params.function_calling`), retrying across version labels. If it still fails, set this model's **Function Calling → Legacy** (v0.10.0+) / **Default** (older) in OpenWebUI's model settings. |
| **⚠️ "isn't available on your server"** | The selected model isn't in `ml.models()`. | Pull it in OpenWebUI, or pick another model from the dropdown. |
| **⚠️ "doesn't advertise tool-calling support"** | The model's Ollama capabilities don't include `tools`. | Pick a tool-capable model (e.g. a `qwen3` variant). Note: for cloud/non-Ollama models the capability is *unknown*, so no badge shows — it may still work. |
| **Model just says "the transcript is available…"** | The model retrieved the transcript but didn't summarize it. | The prompt is hardened against this; if a weaker model still hedges, switch to a stronger one. |
| **Follow-ups never web-search / search errors** | Web Search isn't enabled in OpenWebUI, or the model chose not to search. | Enable it under Admin → Settings → Web Search with a provider; or set `WEB_SEARCH_TOOL_ID = ""` to remove it entirely. |
| **`Server-side tool_ids requires OpenWebUI`** | Your window.ml endpoint is the Ollama-native format. | Point the extension at OpenWebUI's `/api/chat/completions` (OpenAI format). |
| **Red `Blocked script execution in 'about:blank'…` console spam** | The injector runs in every frame; Chrome blocks the sandboxed ad/utility iframes *before any code runs*. | Harmless — it doesn't affect the panel. Filter the console with `-Blocked script execution` if it bothers you. |

### How it works (for hacking on it)

- **Server-side tools, one call.** `ml.createChat({ toolIds: [...] })` keeps the
  transcript tool (and OpenWebUI's built-in `web_search`) available on every
  turn; the model calls whichever it needs and OpenWebUI runs it and returns a
  finished answer — no client-side agent loop. The whole flow lives in the
  userscript; `window.ml` stays a primitive.
- **Trusted Types safe.** YouTube enforces `require-trusted-types-for 'script'`,
  so the panel is built entirely with `createElement`/`textContent` (no
  `innerHTML`), and a tiny markdown renderer returns real DOM nodes.
- **SPA aware.** It re-mounts and resets the chat on `yt-navigate-finish` when
  you move between videos.
- **Streamed.** `chat.chat(prompt, { onToken })` paints tokens into a live bubble
  as they arrive, then swaps in rendered markdown when the reply completes.
