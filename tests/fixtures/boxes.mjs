// The MACHINE SHAPES the panel is exercised against — one per kind of box people actually have, not one per
// number of cards. They live here rather than in either consumer because both need them and a second copy is
// how a guard ends up testing a shape nobody runs: the preset drift guard covered two cards and a Mac, and
// the one-card-plus-RAM machine — the commonest there is — slipped through and shipped a default preset that
// the panel's own stacking rule refused.
//
// `resource-demo.mjs` walks a timeline on one of these (BOX=…); `resource-model.test.mjs` runs every preset
// and every refusal against all of them. What each shape is FOR is in its own comment — the point is the
// property it carries (a spill, nine pools, a unified pool, a vendor tool), never the vendor's marketing.
import { readFileSync } from "node:fs";

const GiB = 1024 ** 3;

const gpu = (o) => ({ compute: "12.0", driver: "13.2", ...o });
/** Each shape: the devices, the host total, and a model catalogue sized to fit THAT machine. */
const BOXES = {
    // gpubox's real shape: two ~95 GiB cards and 121 GiB of system RAM. `physical_memory` is the DRIVER
    // framebuffer total (what nvidia-smi shows); `total_memory` is ollama's own, ~638 MiB lower.
    cuda: {
        runner: "CUDA", hostTotal: 130142785536, idleHeld: 0.55 * GiB,
        // Both utilization figures, as NVML reports them (`ollama-slop:util`) — the Activity preset's shape.
        devices: [0, 1].map((id) => gpu({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA",
            total_memory: 101972967424, physical_memory: 102641958912,
            utilization: { gpu_percent: id ? 0 : 99, memory_percent: id ? 0 : 90 } })),
        models: { a: ["gemma4:31b", 18 * GiB], b: ["qwen3.5:35b", 22 * GiB], c: ["phi5:14b", 9 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["gemma4:31b", 30 * GiB], cpu: ["util:2b", 7 * GiB] },
    },
    // An AMD box: two Instinct-class cards. Same discrete shape, different vendor tool in the note.
    amd: {
        runner: "ROCm", hostTotal: 274877906944, idleHeld: 0.4 * GiB,
        // GPU busy only: the real AMD iGPU has `gpu_busy_percent` and no `mem_busy_percent` file at all, and
        // the two figures are read independently — so one present and one absent is an ordinary AMD shape.
        devices: [0, 1].map((id) => gpu({ gpu_id: String(id), name: `ROCm${id}`, runner: "ROCm",
            total_memory: 68719476736, physical_memory: 68719476736, utilization: { gpu_percent: 40 } })),
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
// ---- TOPOLOGIES: how the cards connect to EACH OTHER, as the patched server reports them ----
//
// TWO KINDS OF ENTRY, and which is which matters. REAL ones are the server's own responses, recorded on gpubox
// (tests/fixtures/hw/*-2026-09-11.json, `ollama-slop:hwceil`): the PCIe pair, one GPU, and NVML unavailable.
// MOCKS are everything NVLink-populated — UNVERIFIED AGAINST REAL HARDWARE, deliberately and by agreement: no
// machine the server was built on has NVLink silicon, so both it and this client were written against the design
// doc. When the first real NVLink `topology` arrives, replace the matching mock with the capture, and whichever
// side disagrees with it is the one that is wrong.
//
// Keys are bus addresses. Every unordered pair appears exactly once; that is the server's promise, and the
// `missing` shape at the end is the one that breaks it.
const pci = (i) => `0000:${String(i + 1).padStart(2, "0")}:00.0`;
const pairs = (n, linkOf) => {
    const out = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push({ a: pci(i), b: pci(j), ...linkOf(i, j) });
    return out;
};
const PHB = { type: "pcie", path: "PHB", pcie_path: "PHB" };
// RTX 3090 NVLink 3.0 bridge: 4 links. The rate is a MOCK figure — the server reads it or omits it.
const NV4 = { type: "nvlink", path: "NV4", nvlink_count: 4, pcie_path: "PHB", bandwidth_bytes_per_sec: 112_500_000_000 };
const NV12 = { type: "nvlink", path: "NV12", nvlink_count: 12, pcie_path: "SYS", bandwidth_bytes_per_sec: 600_000_000_000 };
const hw = (name) => JSON.parse(readFileSync(new URL(`./hw/${name}-2026-09-11.json`, import.meta.url), "utf8"));
const TOPOLOGIES = {
    // REAL: gpubox's two cards across the CPU's host bridge — no NVLink PHY on either — with the link's PEAK
    // bandwidth derived from the PCIe link (measured peer-to-peer on this box: 27.7 GB/s against 31.5 derived).
    pcie2: hw("info-ceilings-and-topology").compute.topology,
    // REAL: one visible GPU (`CUDA_VISIBLE_DEVICES=0`). Measured, and there are simply no pairs.
    oneGpu: hw("topology-one-gpu"),
    // 4x3090, bridges joining 0–1 and 2–3: two bridged pairs, and the pairs that cross them are PCIe only.
    rigAdjacent: { status: "measured", detail: "", gpus: [0, 1, 2, 3].map(pci),
        links: pairs(4, (i, j) => ((i === 0 && j === 1) || (i === 2 && j === 3) ? NV4 : PHB)) },
    // 4x3090, bridges joining 0–2 and 1–3: the same machine cabled differently. The bands must REORDER to
    // 0,2,1,3, or the bridges fall on walls between unlinked cards.
    rigCrossed: { status: "measured", detail: "", gpus: [0, 1, 2, 3].map(pci),
        links: pairs(4, (i, j) => ((i === 0 && j === 2) || (i === 1 && j === 3) ? NV4 : PHB)) },
    // 8x A100 SXM on an NVSwitch: EVERY pair directly linked, so every wall between cards is a bridge.
    nvswitch8: { status: "measured", detail: "", gpus: [0, 1, 2, 3, 4, 5, 6, 7].map(pci), links: pairs(8, () => NV12) },
    // DGX-1V hybrid cube-mesh: each card linked to 4 of its 7 peers (its own quad, plus the card four over).
    // A partial mesh cannot be drawn faithfully on a line — it must never read as ONE group of eight.
    dgx1: { status: "measured", detail: "", gpus: [0, 1, 2, 3, 4, 5, 6, 7].map(pci),
        links: pairs(8, (i, j) => (Math.floor(i / 4) === Math.floor(j / 4) || j - i === 4
            ? { type: "nvlink", path: "NV2", nvlink_count: 2, pcie_path: "SYS" } : { type: "pcie", path: "SYS", pcie_path: "SYS" })) },
    // REAL: the server with NVML made unloadable. Coverage still holds — the one pair is present, `unknown`,
    // carrying the driver's own words — which is what keeps "could not look" from reading as "no link".
    unavailable: hw("topology-nvml-unavailable"),
    // Some pairs classified, one not — present as `unknown` with the reason, never omitted.
    partial: { status: "partial", detail: "NVML did not report a path for one pair", gpus: [0, 1, 2].map(pci),
        links: pairs(3, (i, j) => (i === 1 && j === 2 ? { type: "unknown", reason: "NVML did not report a path for this pair" } : PHB)) },
    // A server BUG: `measured`, but a pair is simply absent. The client must say so, not read it as PCIe.
    missing: { status: "measured", detail: "", gpus: [0, 1, 2].map(pci), links: [{ a: pci(0), b: pci(1), ...PHB }] },
};

export { BOXES, gpu, GiB, TOPOLOGIES, pci };
