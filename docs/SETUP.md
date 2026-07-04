# Setup — from zero to `ml.chat()` in your console

What you need: a Chromium-based browser (Chrome, Edge, Brave, …) and a
reachable [OpenWebUI](https://openwebui.com) instance (or a bare
[Ollama](https://ollama.com) server) **with at least one model pulled** —
a fresh install serves nothing until you `ollama pull` something:

```sh
ollama pull llama3.2            # or: docker exec ollama ollama pull llama3.2
```

## 1. Install the extension

There's no store listing — it loads as an unpacked extension:

1. `git clone https://github.com/parawanderer/window-ml.git` (or download the
   ZIP via GitHub's **Code** button and extract it).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Enable **Developer mode** (toggle in the corner).
4. Click **Load unpacked** and select the cloned folder.

Recommended: on the extension's details page, set **Site access** to
**On click**. Then `window.ml` only exists on pages where you've clicked the
extension icon, instead of on every page you visit.

## 2. Minimum configuration

Click the extension icon to open the settings popup. You need exactly four
values:

| Field | OpenWebUI | Bare Ollama |
| --- | --- | --- |
| Chat completions URL | `http://<host>:3000/api/chat/completions` | `http://<host>:11434/api/chat` |
| API key | OpenWebUI → **Settings → Account → API keys** → create one | *(leave empty)* |
| Model | click **Load**, pick from the list | click **Load**, pick from the list |
| API format | **OpenAI** | **Ollama native** |

Hit **Save & Test** — it sends a real prompt and shows the reply. If you see
text extracted from your model, you're done.

## 3. Use it

Open any web page, click the extension icon once (if you set site access to
On click), open DevTools (F12) → Console:

```js
await ml.chat("Say hi");

// with an image from the page (needs a vision-capable model):
await ml.chat("What's in this image?", { images: [document.images[0]] });

// multi-turn:
const h = ml.createChat({ system: "Be terse." });
await h.chat("What is a monad?");
await h.chat("Shorter.");

// OCR — transcribe text baked into an image to a string (see below):
await ml.read(document.images[0]);
```

### OCR (optional)

`ml.read()` transcribes text that's baked into image pixels. It uses a separate
**vision** model so your chat model can stay text-only. To enable it: pull a
vision model, then set it as the **OCR model** in the popup.

```sh
ollama pull qwen2.5vl        # or: docker exec ollama ollama pull qwen2.5vl
```

Details and the bulk-processing pattern are in the
[README](../README.md#ocr).

The full API is documented in the [README](../README.md#windowml-api). To route
to commercial models (Claude, GPT, OpenRouter) through the same setup, see
[CLOUD-MODELS.md](CLOUD-MODELS.md).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| **Load** says "no models installed" | Your server runs fine but serves nothing — pull a model (see top of this page), then hit **Load** again. |
| `Test failed: HTTP 400 … "Model not found"` | The model id doesn't exist on the server — use the **Load** button instead of typing one. |
| `Unexpected token '<' … not valid JSON` or `HTTP 405` | Wrong URL path for your server — copy it from the table above. OpenWebUI has **no** root-level `/v1/chat/completions`. |
| `HTTP 400 … 'NoneType' object has no attribute 'startswith'` | OpenWebUI 0.9.5 bug ([#24550](https://github.com/open-webui/open-webui/issues/24550)); upgrade OpenWebUI, or use the `/ollama/api/chat` passthrough URL with the **Ollama native** format. |
| `HTTP 403` from a bare Ollama server | Ollama rejects cross-origin callers by default — start it with `OLLAMA_ORIGINS="*"` (or `chrome-extension://*`). Not needed when going through OpenWebUI. |
| `ml is not defined` in the console | Site access is On click and you haven't clicked the icon on this tab yet — click it, reload the page if needed. |
| `Model "…" does not support image input` | Working as intended: you sent images to a text-only model. Pick a vision model (`qwen2.5vl`, `gemma3`, `llava`, …). |
