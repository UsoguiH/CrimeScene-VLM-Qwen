# Evidence // Live Detection & Measurement

Open-source demo: live camera object detection with **real-world size measurement**,
running **100% in the browser** — no server-side inference, no data leaves the machine.

| Capability | Model | Runs |
|---|---|---|
| Real-time object detection | **RF-DETR nano/small/medium** (ICLR 2026, Apache-2.0) | every frame |
| Click-to-register (< 2 s) | detection boxes, no extra model | instant on click |
| Depth overlay | **Depth Anything V2 small** (Apache-2.0) | toggle |
| Evidence report + item ID (VLM) | **Qwen3-VL** — local 2B in-browser, or 235B via OpenRouter API | on demand / per item |

Runtime: [transformers.js v4](https://github.com/huggingface/transformers.js) +
ONNX Runtime Web on **WebGPU** (WASM fallback). Models download from the Hugging Face
hub on first use and are cached by the browser.

See [RESEARCH.md](./RESEARCH.md) for the Phase 0 model-selection research.

## Run

```
node server.mjs
```

Open **http://localhost:8000** in Chrome or Edge (WebGPU). Allow camera access.

Any static file server works (`python -m http.server 8000`, etc.) — camera access
requires `localhost` or HTTPS.

## How it works

1. **Click any object** in the live view → it's matched to the live RF-DETR detection
   box (or a region around your click), measured, and **registered to the dashboard
   instantly** (< 2 s guaranteed, typically < 100 ms in-app). Qwen then identifies the
   item asynchronously (name, color, markings) and updates the dashboard + label.
2. **Calibrate for real units** (sidebar): choose a reference of known length — credit
   card, A4, CD, banknote, custom — press *Set reference (2 clicks)*, then click the
   **two ends** of that object in the view. That yields a px/mm scale for the plane
   (forensic ABFO-scale practice). Model-free and instant.
3. Alternative mode: **known camera distance** — enter distance + camera FOV
   (pinhole model, approximate, no reference object needed).
4. **Depth overlay** renders relative depth (bright = near) as a sanity check that
   measured objects lie in the reference plane.
5. **Snapshot** exports an annotated, timestamped PNG for the evidence log.
6. **Analyze** writes a structured evidence report from the current frame +
   detections + measurements (OpenRouter API mode or fully-local 2B mode).

## Evidence dashboard

Every click-measurement **auto-registers an evidence item**: sequential ID (EV-001…),
cropped thumbnail, dimensions, mask confidence, calibration mode, timestamp, and
editable name/notes. Open it with the **📋 Dashboard** button in the header:

- Items persist in browser localStorage across reloads.
- **Auto-identify with VLM**: when an OpenRouter key is configured, each new item's
  crop is sent to Qwen3-VL for a precise one-line identification (name, color,
  markings) — far beyond the detector's 80 COCO labels. Toggleable in the dashboard.
- Export the registry as **JSON** or **CSV**; edit names/notes inline; re-run ID per item.

## Performance notes

- Detector runs fp32 on WebGPU (fp16 silently breaks DETR-family models) and
  receives downscaled (≤640 px) frames.
- Detector size is switchable in the toolbar: nano (fastest) / small / medium (most accurate).
- Click-to-register uses the live detection boxes directly — no segmentation model
  in the click path, so registration is synchronous (~<100 ms).

## VLM modes

The VLM card has two modes (dropdown):

- **OpenRouter API (default if a key is configured)** — sends the current frame to
  `qwen/qwen3-vl-235b-a22b-instruct` (editable model id). Fast, high quality, costs a
  fraction of a cent per analysis. Put your key in `config.local.js` (git-ignored):

  ```js
  window.EVIDENCE_CONFIG = {
    openrouterKey: 'sk-or-…',
    openrouterModel: 'qwen/qwen3-vl-235b-a22b-instruct',
  };
  ```

  or paste it into the key field in the UI (persisted in browser localStorage).
  Note: in API mode the frame is uploaded to OpenRouter — not fully local.

- **Local in-browser** — Qwen3-VL-2B via WebGPU. 100 % private, no key, ~1.1 GB
  one-time download; slow on integrated GPUs.

## Tests

`test-e2e.mjs` drives the real app in headless Edge with a fake camera feed
(a photo of cats), asserting 28 checks end-to-end — including a hard
"< 2 s click-to-dashboard" timing assertion. Requires `puppeteer-core`
(`npm i puppeteer-core`) and Microsoft Edge.

```
node make-testcam.mjs   # one-time: builds the fake camera feed
node test-e2e.mjs       # runs the suite (self-hosts the server)
```

## Notes & limits

- Plane calibration is only exact for objects in the same plane as the reference,
  viewed roughly straight-on. Expect ~1–5 % error in good conditions.
- RF-DETR nano is COCO-pretrained (80 everyday classes). Clicking works on *any*
  object regardless of class — detection labels are a convenience, not a limit.
- First model load needs internet; afterwards everything is cached and offline-capable.
- WebGPU needs Chrome/Edge 113+. On machines without WebGPU everything still works
  on WASM, just slower (and the VLM becomes impractically slow).
