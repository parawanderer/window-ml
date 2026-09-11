// The edges a REAL box emitted during one agent turn, captured with `ml.__events()` and rebased to start at
// zero. Two models load, one serves three back-to-back periods, and `unload` frames carry no model at all —
// which the server really does emit, and which a client that assumes a name crashes on.
//
// Recorded rather than written because the two bugs this pins were both invisible to a fixture that agreed
// with itself: the fully-qualified model names, and the fact that a reconnect replays all of this again.
export const REAL_EDGES = [
    {"kind": "load.start", "model": "registry.ollama.ai/library/gemma4:e2b", "at": 2000},
    {"kind": "load.weights", "model": "registry.ollama.ai/library/gemma4:e2b", "at": 2730},
    {"kind": "busy.start", "model": "registry.ollama.ai/library/gemma4:e2b", "at": 4298},
    {"kind": "load.complete", "model": "registry.ollama.ai/library/gemma4:e2b", "at": 4298, "weights_ms": 730, "context_ms": 1568},
    {"kind": "busy.end", "model": "registry.ollama.ai/library/gemma4:e2b", "at": 4681},
    {"kind": "expires", "model": "registry.ollama.ai/library/gemma4:e2b", "at": 4681},
    {"kind": "unload", "model": null, "at": 5671},
    {"kind": "load.start", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 6677},
    {"kind": "load.weights", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 7283},
    {"kind": "busy.start", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 12832},
    {"kind": "load.complete", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 12832, "weights_ms": 605, "context_ms": 5549},
    {"kind": "busy.end", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 36154},
    {"kind": "expires", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 36154},
    {"kind": "busy.start", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 36198},
    {"kind": "busy.end", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 39647},
    {"kind": "expires", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 39647},
    {"kind": "busy.start", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 39693},
    {"kind": "busy.end", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 42981},
    {"kind": "expires", "model": "registry.ollama.ai/library/qwen3.8-flash-next:vision", "at": 42981},
];
