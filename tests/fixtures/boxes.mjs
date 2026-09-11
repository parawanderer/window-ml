// The MACHINE SHAPES the panel is exercised against — one per kind of box people actually have, not one per
// number of cards. They live here rather than in either consumer because both need them and a second copy is
// how a guard ends up testing a shape nobody runs: the preset drift guard covered two cards and a Mac, and
// the one-card-plus-RAM machine — the commonest there is — slipped through and shipped a default preset that
// the panel's own stacking rule refused.
//
// `resource-demo.mjs` walks a timeline on one of these (BOX=…); `resource-model.test.mjs` runs every preset
// and every refusal against all of them. What each shape is FOR is in its own comment — the point is the
// property it carries (a spill, nine pools, a unified pool, a vendor tool), never the vendor's marketing.
const GiB = 1024 ** 3;

const gpu = (o) => ({ compute: "12.0", driver: "13.2", ...o });
/** Each shape: the devices, the host total, and a model catalogue sized to fit THAT machine. */
const BOXES = {
    // gpubox's real shape: two ~95 GiB cards and 121 GiB of system RAM. `physical_memory` is the DRIVER
    // framebuffer total (what nvidia-smi shows); `total_memory` is ollama's own, ~638 MiB lower.
    cuda: {
        runner: "CUDA", hostTotal: 130142785536, idleHeld: 0.55 * GiB,
        devices: [0, 1].map((id) => gpu({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA",
            total_memory: 101972967424, physical_memory: 102641958912 })),
        models: { a: ["gemma4:31b", 18 * GiB], b: ["qwen3.5:35b", 22 * GiB], c: ["phi5:14b", 9 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["gemma4:31b", 30 * GiB], cpu: ["util:2b", 7 * GiB] },
    },
    // An AMD box: two Instinct-class cards. Same discrete shape, different vendor tool in the note.
    amd: {
        runner: "ROCm", hostTotal: 274877906944, idleHeld: 0.4 * GiB,
        devices: [0, 1].map((id) => gpu({ gpu_id: String(id), name: `ROCm${id}`, runner: "ROCm",
            total_memory: 68719476736, physical_memory: 68719476736 })),
        models: { a: ["gemma4:31b", 18 * GiB], b: ["qwen3.5:35b", 22 * GiB], c: ["phi5:14b", 9 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["gemma4:31b", 30 * GiB], cpu: ["util:2b", 7 * GiB] },
    },
    // The homelab rig: four RTX 3090s (24 GiB each, NVLink-paired) and 128 GiB of system RAM. The point of
    // this shape is that a 70B model does NOT fit on any one card — it is split across all four, and each
    // card's track shows only its own share.
    rig: {
        runner: "CUDA", hostTotal: 137438953472, idleHeld: 0.35 * GiB,
        devices: [0, 1, 2, 3].map((id) => gpu({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA",
            total_memory: 25757220864, physical_memory: 25769803776 })),
        models: { a: ["qwen3.5:14b", 9 * GiB], b: ["gemma4:12b", 7 * GiB], c: ["phi5:14b", 8 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["llama4:70b", 21 * GiB], cpu: ["util:2b", 3 * GiB] },
    },
    // The ordinary consumer machine: an RTX 4080 Laptop (12 GiB GDDR6) and 32 GiB of system RAM. The whole
    // point of this shape is that things DON'T fit — a 27B model has to be split between the card and RAM,
    // which is the everyday case the big boxes never show.
    //
    // ONE device, deliberately: the laptop also has an integrated GPU, but ollama's CUDA build enumerates CUDA
    // devices only, so an Intel/AMD iGPU doesn't appear unless the Vulkan backend is in play. (If it ever
    // does, it is a UNIFIED device — it has no memory of its own, it shares system RAM — sitting beside a
    // discrete one, which is a shape the model does not handle today: `Capacity.unified` is true when ANY
    // device is unified, which would collapse the 4080's own pool into the host's. Wants a real capture.)
    laptop: {
        runner: "CUDA", hostTotal: 34359738368, idleHeld: 0.3 * GiB,
        devices: [gpu({ gpu_id: "0", name: "CUDA0", runner: "CUDA",
            total_memory: 12736200704, physical_memory: 12884901888 })],
        models: { a: ["qwen3.5:8b", 5 * GiB], b: ["gemma4:12b", 7 * GiB], c: ["phi5:4b", 3 * GiB],
                  d: ["coder:3b", 2 * GiB], big: ["gemma4:27b", 9 * GiB], cpu: ["util:1b", 2 * GiB] },
    },
    // The lab node: eight A100 80GB and a terabyte of RAM. NINE pools — past the curated palette, which is
    // where "colour per pool" has to keep meaning something.
    lab: {
        runner: "CUDA", hostTotal: 1099511627776, idleHeld: 0.6 * GiB,
        devices: [0, 1, 2, 3, 4, 5, 6, 7].map((id) => gpu({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA",
            total_memory: 85899345920, physical_memory: 85899345920 })),
        models: { a: ["gemma4:31b", 18 * GiB], b: ["qwen3.5:35b", 22 * GiB], c: ["phi5:14b", 9 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["deepseek:671b", 70 * GiB], cpu: ["util:2b", 7 * GiB] },
    },
    // A Mac: ONE unified pool. `total_memory` is the advised working set (~75% of the system), NOT a second
    // pool — and there is no physical_memory and no vendor tool to point at.
    metal: {
        runner: "Metal", hostTotal: 34359738368, idleHeld: 0.2 * GiB,
        devices: [gpu({ gpu_id: "0", name: "MTL0", runner: "Metal", total_memory: 25769803776 })],
        models: { a: ["gemma4:12b", 7 * GiB], b: ["qwen3.5:8b", 5 * GiB], c: ["phi5:4b", 3 * GiB],
                  d: ["coder:3b", 2 * GiB], big: ["gemma4:12b", 11 * GiB], cpu: ["util:1b", 2 * GiB] },
    },
};
export { BOXES, gpu, GiB };
