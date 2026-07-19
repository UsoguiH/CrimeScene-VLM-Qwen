// worker.js — ML inference worker (module worker).
// Runs RF-DETR (detection), Depth Anything V2 (depth) and Qwen3-VL (analysis)
// fully in-browser via transformers.js v4 + WebGPU.

const TF_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

const DETECTOR_IDS = {
  nano: 'onnx-community/rfdetr_nano-ONNX',
  small: 'onnx-community/rfdetr_small-ONNX',
  medium: 'onnx-community/rfdetr_medium-ONNX',
};

const MODELS = {
  depth: 'onnx-community/depth-anything-v2-small',
  vlm: 'onnx-community/Qwen3-VL-2B-Instruct-ONNX',
};

let detectorSize = 'nano';

let tf = null;
let device = 'wasm';
const loaded = { detector: null, depth: null, vlm: null };

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (scope, state, detail = '') => post({ type: 'status', scope, state, detail });

function progressFor(scope) {
  return (p) => {
    if (p && p.status === 'progress') {
      post({ type: 'progress', scope, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    }
  };
}

function toRawImage(image) {
  return new tf.RawImage(new Uint8ClampedArray(image.data), image.width, image.height, 4);
}

// --- model loaders (lazy) ----------------------------------------------------

async function ensureRuntime() {
  if (tf) return;
  status('runtime', 'loading', 'Fetching transformers.js…');
  tf = await import(TF_CDN);
  tf.env.allowLocalModels = false;
  try {
    const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter() : null;
    device = adapter ? 'webgpu' : 'wasm';
  } catch {
    device = 'wasm';
  }
  status('runtime', 'ready', device);
}

async function loadWithFallback(scope, loadFn) {
  try {
    return await loadFn(device);
  } catch (err) {
    if (device === 'webgpu') {
      status(scope, 'loading', 'WebGPU failed, retrying on WASM…');
      return await loadFn('wasm');
    }
    throw err;
  }
}

async function ensureDetector() {
  if (loaded.detector) return loaded.detector;
  const modelId = DETECTOR_IDS[detectorSize] ?? DETECTOR_IDS.nano;
  status('detector', 'loading', `RF-DETR ${detectorSize}`);
  // fp32 on WebGPU: fp16 silently breaks DETR-style models (overflow -> no boxes)
  loaded.detector = await loadWithFallback('detector', (dev) =>
    tf.pipeline('object-detection', modelId, {
      device: dev, progress_callback: progressFor('detector'),
    }),
  );
  status('detector', 'ready', `RF-DETR ${detectorSize}`);
  return loaded.detector;
}

async function ensureDepth() {
  if (loaded.depth) return loaded.depth;
  status('depth', 'loading', 'Depth Anything V2 small (~50 MB, first use only)');
  loaded.depth = await loadWithFallback('depth', (dev) =>
    tf.pipeline('depth-estimation', MODELS.depth, {
      device: dev,
      progress_callback: progressFor('depth'),
    }),
  );
  status('depth', 'ready');
  return loaded.depth;
}

async function ensureVlm() {
  if (loaded.vlm) return loaded.vlm;
  status('vlm', 'loading', 'Qwen3-VL-2B-Instruct (~1.1 GB, first use only)');
  loaded.vlm = await loadWithFallback('vlm', async (dev) => {
    const processor = await tf.AutoProcessor.from_pretrained(MODELS.vlm, {
      progress_callback: progressFor('vlm'),
    });
    const model = await tf.AutoModelForImageTextToText.from_pretrained(MODELS.vlm, {
      device: dev,
      dtype: {
        embed_tokens: 'fp16',
        vision_encoder: 'fp16',
        decoder_model_merged: 'q4f16',
      },
      progress_callback: progressFor('vlm'),
    });
    return { processor, model };
  });
  status('vlm', 'ready');
  return loaded.vlm;
}

// --- job handlers -------------------------------------------------------------

async function handleDetect({ image, threshold }) {
  const detector = await ensureDetector();
  const raw = toRawImage(image);
  const t0 = performance.now();
  const output = await detector(raw, { threshold: threshold ?? 0.5 });
  return {
    ms: performance.now() - t0,
    boxes: output.map((d) => ({
      label: d.label,
      score: d.score,
      x1: d.box.xmin, y1: d.box.ymin, x2: d.box.xmax, y2: d.box.ymax,
    })),
  };
}

async function handleDepth({ image }) {
  const depth = await ensureDepth();
  const raw = toRawImage(image);
  const t0 = performance.now();
  const out = await depth(raw);
  const d = out.depth; // RawImage, 1 channel, 0..255 (255 = nearest)
  const bytes = new Uint8Array(d.data); // copy so we can transfer safely
  return {
    ms: performance.now() - t0,
    depth: { data: bytes, width: d.width, height: d.height },
    _transfer: [bytes.buffer],
  };
}

async function handleAnalyze({ id, image, prompt }) {
  const vlm = await ensureVlm();
  const raw = toRawImage(image);
  const messages = [{
    role: 'user',
    content: [{ type: 'image' }, { type: 'text', text: prompt }],
  }];
  const text = vlm.processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await vlm.processor(text, raw);
  let generated = '';
  const streamer = new tf.TextStreamer(vlm.processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      generated += chunk;
      post({ type: 'vlm-token', id, text: chunk });
    },
  });
  const t0 = performance.now();
  await vlm.model.generate({ ...inputs, max_new_tokens: 512, do_sample: false, streamer });
  return { ms: performance.now() - t0, text: generated };
}

// --- dispatch (serialized so GPU jobs never interleave) ------------------------

let chain = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      await ensureRuntime();
      let data;
      switch (msg.type) {
        case 'init':
          if (msg.detector && DETECTOR_IDS[msg.detector]) detectorSize = msg.detector;
          await ensureDetector();
          post({ type: 'ready', backend: device });
          return;
        case 'set-detector': {
          if (DETECTOR_IDS[msg.size] && msg.size !== detectorSize) {
            detectorSize = msg.size;
            await loaded.detector?.dispose?.();
            loaded.detector = null;
            await ensureDetector();
          }
          data = { size: detectorSize };
          break;
        }
        case 'detect': data = await handleDetect(msg); break;
        case 'depth': data = await handleDepth(msg); break;
        case 'load-vlm': await ensureVlm(); data = {}; break;
        case 'analyze': data = await handleAnalyze(msg); break;
        default: return;
      }
      const transfer = data._transfer;
      delete data._transfer;
      post({ type: 'result', id: msg.id, ok: true, data }, transfer);
    } catch (err) {
      console.error('[worker]', msg.type, err);
      if (msg.type === 'init') {
        status('detector', 'error', String(err?.message || err));
      } else {
        post({ type: 'result', id: msg.id, ok: false, error: String(err?.message || err) });
      }
    }
  });
};
