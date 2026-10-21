# Tool-call fragments: raw streams from the patched Ollama

Raw streams of a tool call being written, captured on mlbox on 2026-10-21 from `parawanderer/ollama` branch
`slop-stream-tool-args` (67882976 plumbing, 6374360c the qwen3-coder parser), deployed as `ollama-slop:streamargs`.
Each file is the response body exactly as the server sent it. `tests/background-stream-calls.test.js` replays them
through the worker. Settings for all four: `think: false` (`reasoning_effort: "none"` on `/v1`), `temperature: 0`,
one tool, `python_exec(code: string)`.

| File | Model, endpoint | What it shows |
| --- | --- | --- |
| `qwen3.6-native-2026-10-21.ndjson` | qwen3.6:35b, `/api/chat` | `message.tool_call_deltas` in 258 lines, then the whole `tool_calls`; the fragments join to the final arguments byte for byte |
| `qwen3.6-v1-2026-10-21.sse` | qwen3.6:35b, `/v1/chat/completions` SSE | the same prompt as OpenAI `delta.tool_calls` fragments, `finish_reason: tool_calls`; no whole call |
| `qwen3.6-v1-protobuf-2026-10-21.bin` | qwen3.6:35b, `/v1` protobuf (`Accept: application/protobuf; events=1`) | a short call as varint-delimited `Frame`s: one start, the `Delta.tool_calls` fragments, one end |
| `qwen3.8-flash-next-native-2026-10-21.ndjson` | qwen3.8-flash-next, `/api/chat` (the llama-server path) | fragments are llama.cpp's JSON and the whole call is Go's re-encoding (`<` as `<`): equal in value, not in bytes |

The test renames the tool to `survey_page` (the same length, so the protobuf framing still holds) so the call runs as
a page tool, without a Python sandbox. Where the final call can differ from the fragments, and why: the fork's report,
summarised in `docs/FORKED-BACKENDS.md`.
