# Using cloud / commercial models (OpenAI, Anthropic, OpenRouter)

`window.ml` talks to whatever models your OpenWebUI serves. OpenWebUI is a
router: add a commercial provider as a **Connection** and its
models appear in the same list as your local Ollama ones.

Provided you have set up a link to a cloud model provider, you would see something like:

```js
await ml.models();                       // lists e.g. "claude-opus-4-8" too
await ml.setModel("claude-opus-4-8");    // switch your default to it
await ml.chat("Explain this diff", { model: "gpt-5.2", think: null });  // one-off
```

## Add a connection in OpenWebUI

Admin Panel → **Settings → Connections → OpenAI → ➕ Add Connection**, then
fill in the base URL and your API key. The URL field suggests known providers
as you type. Three good options:

| Provider | Base URL | Notes |
| --- | --- | --- |
| **OpenRouter** *(recommended)* | `https://openrouter.ai/api/v1` | One key, every provider (incl. Claude + GPT). Pay-as-you-go, so stopping costs nothing. It exposes thousands of models — use the connection's **Model IDs allowlist** to show only the few you want. |
| **OpenAI** | `https://api.openai.com/v1` | GPT models directly. |
| **Anthropic** | `https://api.anthropic.com/v1` | Claude directly. OpenWebUI auto-detects the Anthropic URL and handles model discovery via its built-in compatibility layer. Current model IDs: `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5`. |

Once saved, hit **Load** in the extension popup (or call `ml.models()`) — the
new models are in the list. Keep your existing **API format = OpenAI** and URL
pointing at OpenWebUI (`.../api/chat/completions`); OpenWebUI routes to the
right provider based on the model id.

## Two gotchas specific to non-Ollama models

Both degrade gracefully, but knowing them saves a confusing minute:

1. **The `think` parameter.** Every `ml.chat` call sends Ollama's `think:
   false` by default (that's how thinking is suppressed on local models,
   forwarded by OpenWebUI). Some upstream APIs reject unknown parameters. **If
   a cloud model errors with something about an unexpected `think` field, pass
   `{ think: null }`** to omit it entirely:

   ```js
   const claude = ml.createChat({ model: "claude-opus-4-8", think: null });
   await claude.chat("...");   // think never sent
   ```

   `think: null` is the general "let the server decide / don't send it" value.

2. **The vision capability check.** The fail-fast image guard reads Ollama's
   `/api/show`, which doesn't exist for cloud models — so the probe returns
   "unknown" and the request is sent anyway rather than blocked. Cloud vision
   models (Claude, GPT-4o-class) accept images fine; if you send images to a
   text-only cloud model, you'll get the server's own error, annotated with a
   note that images were included.

## Structured output

`schema` works against cloud models too — commercial APIs generally have
robust JSON-schema support, so the `schema` option (see the
[README](../README.md#windowml-api)) is often *more* reliable there than
against a small local model.
