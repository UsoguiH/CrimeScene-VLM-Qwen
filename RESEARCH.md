# PHASE 0 — Research Report

**Project:** Evidence Live Detection & Measurement (open-source demo)
**Date:** 2026-07-16
**Question:** Is SAM 2.1 + RF-DETR + Qwen3-VL the strongest open-source stack for live
detection with VLM capabilities and real-world size measurement?

---

## Verdict — the proposed stack, model by model

### 1. RF-DETR — ✅ KEEP. Still the strongest real-time open detector (July 2026)

- RF-DETR (Roboflow, ICLR 2026) is the current accuracy leader among real-time
  detectors: **RF-DETR-L hits 56.5 AP(50:95) on COCO at 6.8 ms on a T4**, beating
  YOLOv11x (54.7 AP) at *lower* latency; it also leads on occlusion handling and
  domain shift vs. YOLO26/YOLOv12.
- License: **Apache-2.0** (YOLO11/26 are AGPL-3.0 — a real problem for an
  "open source" demo you want others to reuse).
- Comes in nano/small/medium/base/large; official ONNX exports exist, and
  **transformers.js v4 supports the `rf_detr` architecture natively**
  (`onnx-community/rfdetr_nano-ONNX` etc.), so it runs in-browser on WebGPU.
- Caveat: on bare CPU it's ~1 s/frame — it needs *some* GPU (WebGPU/iGPU counts).

### 2. SAM 2.1 — ✅ KEEP for this demo, but know that SAM 3 / 3.1 exists

- **SAM 3 (Meta, Nov 2025) and SAM 3.1 supersede SAM 2.1 in raw capability**: unified
  detection + segmentation + tracking, open-vocabulary *text* prompts ("yellow school
  bus"), ~2× accuracy gain on promptable concept segmentation, and SAM 3.1 is ~4×
  faster than SAM 2 (fits a 33 ms / 30 fps budget **on datacenter GPUs**).
- BUT for this project SAM 2.1 remains the right call:
  - SAM 3 weights are **gated behind a custom Meta "SAM License"** (not OSI
    open-source); SAM 2.1 is **Apache-2.0**.
  - SAM 3 is ~840 M params — not deployable in-browser or on an iGPU laptop.
  - SAM 2.1 **hiera-tiny** has browser-ready ONNX
    (`onnx-community/sam2.1-hiera-tiny-ONNX`) with native transformers.js support
    (`Sam2Model`), including **box prompts** — so RF-DETR boxes can seed SAM 2.1
    masks directly.
- Upgrade path: if this ever moves to a server GPU, swap SAM 2.1 → SAM 3.1 and it
  can absorb both detection and segmentation via text prompts.

> **Post-research note (2026-07-18):** SAM 2.1 was later removed from the demo
> entirely — click-to-register now uses the live RF-DETR boxes directly, which is
> instant (<100 ms) and needs no extra model. The analysis above is kept for the
> record.

### 3. Qwen3-VL — ✅ KEEP. Strongest open-weights VLM for grounding right now

- Qwen3-VL (Apache-2.0) has genuine detection-grade **2D grounding**: it returns
  bounding boxes in normalized 0–1000 coordinates, can locate hundreds of objects,
  and adds 3D grounding — the best open VLM for spatial/evidence-style analysis.
- It is **not real-time** — it's the *reasoning layer*, not the per-frame detector.
  Correct architecture: RF-DETR runs every frame; Qwen3-VL runs on demand
  ("analyze this frame → written evidence report").
- Deployment on this machine (no NVIDIA GPU, 16 GB RAM):
  **`onnx-community/Qwen3-VL-2B-Instruct-ONNX`** runs in-browser via
  transformers.js v4 WebGPU (q4f16 decoder ≈ 1.1 GB download). 4B/8B ONNX also
  exist if the host machine is stronger.

### 4. ⚠️ The gap in the proposed stack: none of those three measures anything

Detection + segmentation + VLM gives you *what* and *where in pixels* — not
*how big in the real world*. A measurement layer is required:

| Approach | Accuracy | Cost | Notes |
|---|---|---|---|
| **Reference-object plane calibration** (credit card / A4 / ruler in frame) | High (~1–3 %) | zero | This is literally how forensic evidence photography works (ABFO scales). Valid for objects in the same plane as the reference. |
| **Known-distance pinhole model** (user enters camera→object distance + FOV) | Medium | zero | `size = pixels × Z / fx`. Good fallback, no reference object needed. |
| **Metric monocular depth** (Depth Pro, Depth Anything V2 Metric) | Medium-low zero-shot | heavy | Depth Pro is the best zero-shot metric model but slow & Apple-licensed. DA-V2 Metric small is Apache-2.0, but only unofficial ONNX conversions exist for browsers. |
| **Relative depth** (Depth Anything V2 small) | n/a (relative only) | ~50 MB, real-time in browser | Can't give absolute size alone, but great as a depth overlay + same-plane sanity check. |

**Demo decision:** reference-object calibration (primary) + known-distance pinhole
(fallback) + Depth Anything V2 small as a live depth overlay. All Apache-2.0.

---

## Hardware audit of the dev machine → architecture decision

| Component | Found | Implication |
|---|---|---|
| GPU | Intel Iris Xe (integrated), **no NVIDIA** | PyTorch/CUDA stack unusable; WebGPU works on Iris Xe |
| CPU | i7-1160G7, 4 cores / 8 threads | CPU-only inference ≈ 1 FPS — not "live" |
| RAM | 16 GB (shared with iGPU) | 2B-class VLM q4 is the ceiling |
| Python | 3.13 (no torch installed) | Python route = multi-GB install + still slow |
| Node | v23.8 | can serve a static web app |

→ **Fully in-browser app** (transformers.js v4 + ONNX Runtime Web + WebGPU).
Zero install, zero server-side inference, 100 % local & private, all models
Apache-2.0. This is also the most portable demo: anyone with Chrome/Edge opens a
URL and it just works, using *their* GPU.

## Final stack

| Role | Model | Size (browser) | License |
|---|---|---|---|
| Real-time detection | RF-DETR nano (`onnx-community/rfdetr_nano-ONNX`) | ~25 MB | Apache-2.0 |
| VLM evidence analysis | Qwen3-VL-2B-Instruct (`onnx-community/Qwen3-VL-2B-Instruct-ONNX`, q4f16) | ~1.1 GB, on-demand | Apache-2.0 |
| Depth overlay | Depth Anything V2 small (`onnx-community/depth-anything-v2-small`) | ~50 MB, on-demand | Apache-2.0 |
| Measurement | Two-click reference-plane calibration + pinhole model | pure JS | — |
| Runtime | transformers.js v4.2 + ONNX Runtime Web (WebGPU, WASM fallback) | CDN | Apache-2.0 / MIT |

## Sources

- [RF-DETR vs YOLO comparison (Roboflow)](https://blog.roboflow.com/rf-detr-vs-yolo/) · [Best object detection models 2026](https://blog.roboflow.com/best-object-detection-models/) · [RF-DETR docs & export](https://rfdetr.roboflow.com/latest/)
- [Meta AI: SAM 3.1 announcement](https://ai.meta.com/blog/segment-anything-model-3/) · [facebookresearch/sam3](https://github.com/facebookresearch/sam3) · [facebook/sam3 license (gated)](https://huggingface.co/facebook/sam3/blob/main/LICENSE) · [SAM evolution overview](https://sodevelopment.medium.com/sam-1-vs-sam-2-vs-sam-3-the-complete-evolution-of-segment-anything-models-7650bdaf348c)
- [Qwen3-VL Technical Report](https://arxiv.org/pdf/2511.21631) · [Qwen3-VL spatial grounding (DeepWiki)](https://deepwiki.com/QwenLM/Qwen3-VL/5.2-spatial-understanding-and-2d-grounding) · [Grounding Qwen3-VL detection with SAM2](https://debuggercafe.com/grounding-qwen3-vl-detection-with-sam2/)
- [Depth Pro metric depth (LearnOpenCV)](https://learnopencv.com/depth-pro-monocular-metric-depth/) · [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) · [DA-V2 Metric Indoor Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf) · [metric ONNX support issue](https://github.com/huggingface/transformers.js/issues/1476)
- [Transformers.js v4 release (WebGPU runtime, Qwen3-VL support)](https://github.com/huggingface/transformers.js/releases/tag/4.0.0) · [Transformers.js v3 WebGPU blog](https://huggingface.co/blog/transformersjs-v3) · [ONNX Runtime Web WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [In-browser SAM2 segmentation](https://medium.com/@geronimo7/in-browser-image-segmentation-with-segment-anything-model-2-c72680170d92) · [SlimSAM in transformers.js](https://huggingface.co/Xenova/slimsam-77-uniform)
