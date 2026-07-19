// app.js — main thread: camera, render loop, UI, worker orchestration.
import {
  REFERENCE_PRESETS, focalPx, pxToMm, formatMm, formatSize,
} from './measure.js';

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('stage'), video: $('video'), frame: $('frame'), overlay: $('overlay'),
  stageMsg: $('stage-msg'),
  backendChip: $('chip-backend'), fpsChip: $('chip-fps'), detChip: $('chip-detector'),
  cameraSel: $('camera-select'), btnFlip: $('btn-flip'),
  btnSnapshot: $('btn-snapshot'),
  btnClear: $('btn-clear'), depthToggle: $('depth-toggle'),
  threshold: $('threshold'), thresholdVal: $('threshold-val'),
  calibMode: $('calib-mode'), planeUi: $('calib-plane-ui'), pinholeUi: $('calib-pinhole-ui'),
  refPreset: $('ref-preset'), customDims: $('custom-dims'),
  customLong: $('custom-long'), customShort: $('custom-short'),
  btnSetRef: $('btn-set-ref'), calibStatus: $('calib-status'),
  distanceCm: $('distance-cm'), hfovDeg: $('hfov-deg'),
  detList: $('detections-list'), measureList: $('measure-list'),
  vlmCard: $('vlm-card'), btnLoadVlm: $('btn-load-vlm'), vlmProgress: $('vlm-progress'),
  vlmProgressBar: $('vlm-progress-bar'), vlmProgressText: $('vlm-progress-text'),
  vlmMode: $('vlm-mode'), vlmApiUi: $('vlm-api-ui'), vlmLocalUi: $('vlm-local-ui'),
  apiKey: $('api-key'), apiModel: $('api-model'),
  vlmControls: $('vlm-controls'), vlmQuestion: $('vlm-question'),
  btnAnalyze: $('btn-analyze'), vlmOutput: $('vlm-output'), btnCopyReport: $('btn-copy-report'),
  toast: $('toast'), loadStatus: $('load-status'),
  detModel: $('det-model'),
  btnDashboard: $('btn-dashboard'), dashCount: $('dash-count'), dashboard: $('dashboard'),
  btnDashClose: $('btn-dash-close'), dashTbody: $('dash-tbody'), dashStats: $('dash-stats'),
  btnExportJson: $('btn-export-json'), btnExportCsv: $('btn-export-csv'),
  btnClearRegistry: $('btn-clear-registry'), autoIdToggle: $('auto-id-toggle'),
};

const PALETTE = ['#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#fb7185'];
const REF_COLOR = '#f59e0b';

const S = {
  captureW: 0, captureH: 0,
  detectorReady: false,
  backend: '…',
  detections: [],
  inferMs: 0, fps: 0,
  measurements: [],   // {id,name,corners,centroid,longPx,shortPx,longMm,shortMm,color,score,depth}
  nextMeasureId: 1,
  calib: { mode: 'none', pxPerMm: null, refName: null },
  clickMode: 'measure', // 'measure' | 'reference'
  refPoints: [],      // two-click reference calibration in progress
  depthOn: false, depthMap: null, depthBitmap: null,
  vlmState: 'unloaded', vlmBusy: false, vlmMode: 'local',
  facing: 'user',
  vlmBytes: new Map(),
  registry: [],           // persisted evidence items
  detSize: 'nano',
  jobs: new Map(), nextJobId: 1,
};

let frameCtx, overlayCtx;

// --- worker plumbing ---------------------------------------------------------

const worker = new Worker('./js/worker.js', { type: 'module' });

function job(type, payload = {}, transfer = []) {
  const id = S.nextJobId++;
  return new Promise((resolve, reject) => {
    S.jobs.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...payload }, transfer);
  });
}

worker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      S.detectorReady = true;
      S.backend = msg.backend;
      els.backendChip.textContent = msg.backend === 'webgpu' ? 'WebGPU ⚡' : 'WASM (slow)';
      els.backendChip.classList.toggle('chip-warn', msg.backend !== 'webgpu');
      els.detChip.textContent = `RF-DETR ${S.detSize} ready`;
      els.detChip.classList.add('chip-ok');
      setLoadStatus('');
      break;
    case 'status':
      onStatus(msg);
      break;
    case 'progress':
      onProgress(msg);
      break;
    case 'vlm-token': {
      const j = S.jobs.get(msg.id);
      if (j) els.vlmOutput.textContent += msg.text;
      els.vlmOutput.scrollTop = els.vlmOutput.scrollHeight;
      break;
    }
    case 'result': {
      const j = S.jobs.get(msg.id);
      if (!j) break;
      S.jobs.delete(msg.id);
      msg.ok ? j.resolve(msg.data) : j.reject(new Error(msg.error));
      break;
    }
  }
};

worker.onerror = (e) => {
  setLoadStatus(`Worker error: ${e.message}`, true);
};

function onStatus({ scope, state, detail }) {
  console.log(`[status] ${scope}: ${state}${detail ? ' — ' + detail : ''}`);
  if (scope === 'vlm') {
    if (state === 'loading') { els.vlmProgress.hidden = false; els.vlmProgressText.textContent = detail || 'Loading…'; }
    if (state === 'ready') {
      S.vlmState = 'ready';
      els.vlmProgress.hidden = true;
      els.btnLoadVlm.hidden = true;
      updateVlmUi();
    }
    if (state === 'error') { els.vlmProgressText.textContent = 'Error: ' + detail; }
    return;
  }
  if (state === 'loading') setLoadStatus(`Loading ${detail || scope}…`);
  else if (state === 'error') setLoadStatus(`${scope} failed: ${detail}`, true);
  else if (scope !== 'runtime') setLoadStatus('');
}

function onProgress({ scope, file, loaded, total }) {
  if (scope === 'vlm') {
    S.vlmBytes.set(file, { loaded, total });
    let l = 0, t = 0;
    for (const v of S.vlmBytes.values()) { l += v.loaded; t += v.total; }
    if (t > 0) {
      const pct = Math.min(100, (l / t) * 100);
      els.vlmProgressBar.style.width = pct.toFixed(1) + '%';
      els.vlmProgressText.textContent = `Downloading Qwen3-VL-2B — ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`;
    }
  } else if (total > 0) {
    setLoadStatus(`Loading ${scope}: ${file ? file.split('/').pop() : ''} ${((loaded / total) * 100).toFixed(0)}%`);
  }
}

function setLoadStatus(text, isError = false) {
  els.loadStatus.textContent = text;
  els.loadStatus.classList.toggle('error', isError);
  els.loadStatus.hidden = !text;
}

// --- camera -------------------------------------------------------------------

let currentDeviceId = null;

async function startCamera(opts = {}) {
  const videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (opts.deviceId) videoConstraints.deviceId = { exact: opts.deviceId };
  else if (opts.facing) videoConstraints.facingMode = { ideal: opts.facing };

  const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
  const old = els.video.srcObject;
  els.video.srcObject = stream;
  await new Promise((res) => { els.video.onloadedmetadata = res; });
  await els.video.play();
  old?.getTracks().forEach((t) => t.stop());

  const scale = Math.min(1, 1280 / els.video.videoWidth);
  S.captureW = Math.round(els.video.videoWidth * scale);
  S.captureH = Math.round(els.video.videoHeight * scale);
  for (const c of [els.frame, els.overlay]) { c.width = S.captureW; c.height = S.captureH; }
  els.stage.style.aspectRatio = `${S.captureW} / ${S.captureH}`;
  frameCtx = els.frame.getContext('2d', { willReadFrequently: true });
  overlayCtx = els.overlay.getContext('2d');
  els.stageMsg.hidden = true;

  // a different physical camera invalidates any px/mm calibration
  const newId = stream.getVideoTracks()[0].getSettings().deviceId || '';
  if (currentDeviceId && newId !== currentDeviceId) {
    if (S.calib.mode !== 'none' || S.measurements.length) {
      S.calib = { mode: 'none', pxPerMm: null, refName: null };
      S.refPoints = [];
      S.measurements = [];
      els.calibStatus.textContent = 'Not calibrated (camera changed)';
      renderMeasureList();
      toast('Camera changed — recalibrate for real-world sizes');
    }
  }
  currentDeviceId = newId;

  // refresh camera list (labels available after permission granted)
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  els.cameraSel.innerHTML = '';
  for (const cam of cams) {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${els.cameraSel.length + 1}`;
    if (cam.deviceId === newId) opt.selected = true;
    els.cameraSel.appendChild(opt);
  }
  return newId;
}

// --- capture helpers -----------------------------------------------------------

function grabFrame() {
  return frameCtx.getImageData(0, 0, S.captureW, S.captureH);
}

function packImage(imgData) {
  return {
    payload: { image: { data: imgData.data.buffer, width: imgData.width, height: imgData.height } },
    transfer: [imgData.data.buffer],
  };
}

function grabScaled(maxSide) {
  const scale = Math.min(1, maxSide / Math.max(S.captureW, S.captureH));
  const w = Math.round(S.captureW * scale), h = Math.round(S.captureH * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(els.frame, 0, 0, w, h);
  return c.getContext('2d').getImageData(0, 0, w, h);
}

// --- render loop ----------------------------------------------------------------

function labelColor(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 360;
  return `hsl(${h} 85% 60%)`;
}

function render() {
  if (frameCtx) {
    if (els.video.readyState >= 2) {
      frameCtx.drawImage(els.video, 0, 0, S.captureW, S.captureH);
    }
    drawOverlay();
  }
  requestAnimationFrame(render);
}

function drawOverlay() {
  const ctx = overlayCtx;
  const W = S.captureW, H = S.captureH;
  ctx.clearRect(0, 0, W, H);

  // depth layer
  if (S.depthOn && S.depthBitmap) {
    ctx.globalAlpha = 0.45;
    ctx.drawImage(S.depthBitmap, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // live detections
  ctx.font = '13px ui-monospace, monospace';
  ctx.lineWidth = 2;
  for (const d of S.detections) {
    const color = labelColor(d.label);
    ctx.strokeStyle = color;
    ctx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
    let text = `${d.label} ${(d.score * 100).toFixed(0)}%`;
    const wMm = pxToMm(d.x2 - d.x1, activeCalib());
    if (wMm != null) {
      const hMm = pxToMm(d.y2 - d.y1, activeCalib());
      text += `  ~${formatMm(wMm)}×${formatMm(hMm)}`;
    }
    const tw = ctx.measureText(text).width + 10;
    const ty = d.y1 > 20 ? d.y1 - 18 : d.y1 + 2;
    ctx.fillStyle = 'rgba(8,12,16,0.82)';
    ctx.fillRect(d.x1, ty, tw, 17);
    ctx.fillStyle = color;
    ctx.fillText(text, d.x1 + 5, ty + 13);
  }

  // registered measurements (box outlines + dimension labels)
  for (const m of S.measurements) {
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    m.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();

    const sizeText = m.longMm != null
      ? `${formatMm(m.longMm)} × ${formatMm(m.shortMm)}`
      : `${m.longPx.toFixed(0)} × ${m.shortPx.toFixed(0)} px`;
    const text = `#${m.id} ${m.name} — ${sizeText}`;
    ctx.font = 'bold 13px ui-monospace, monospace';
    const tw = ctx.measureText(text).width + 12;
    const [cx, cy] = m.centroid;
    const tx = Math.max(4, Math.min(W - tw - 4, cx - tw / 2));
    const ty = Math.max(20, cy - 10);
    ctx.fillStyle = 'rgba(8,12,16,0.88)';
    ctx.fillRect(tx, ty - 14, tw, 19);
    ctx.fillStyle = m.color;
    ctx.fillText(text, tx + 6, ty);
  }

  // calibration reference line (persists once calibrated)
  if (S.calib.refLine) {
    const [a, b] = S.calib.refLine;
    ctx.strokeStyle = REF_COLOR;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = REF_COLOR;
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.fillText(`REF ${S.calib.refName}`, (a[0] + b[0]) / 2 + 8, (a[1] + b[1]) / 2 - 8);
  }

  // reference-mode instructions + first point marker
  if (S.clickMode === 'reference') {
    ctx.fillStyle = REF_COLOR;
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.fillText(`◎ CLICK THE TWO ENDS OF THE REFERENCE (${S.refPoints.length}/2)`, 12, 24);
    if (S.refPoints.length === 1) {
      const [p] = S.refPoints;
      ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// --- detection loop --------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// send a downscaled frame to the detector — 4x less data to copy & preprocess
const DETECT_MAX = 640;
const detCanvas = document.createElement('canvas');
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

function grabDetectFrame() {
  const scale = Math.min(1, DETECT_MAX / Math.max(S.captureW, S.captureH));
  if (scale === 1) return { img: grabFrame(), scale: 1 };
  const w = Math.round(S.captureW * scale), h = Math.round(S.captureH * scale);
  detCanvas.width = w; detCanvas.height = h;
  detCtx.drawImage(els.frame, 0, 0, w, h);
  return { img: detCtx.getImageData(0, 0, w, h), scale };
}

async function detectLoop() {
  let lastT = performance.now();
  let warmingUp = true;
  while (true) {
    if (S.detectorReady && !S.vlmBusy && frameCtx) {
      try {
        if (warmingUp) els.fpsChip.textContent = 'warming up (compiling GPU shaders)…';
        const { img, scale } = grabDetectFrame();
        const { payload, transfer } = packImage(img);
        payload.threshold = S.threshold ?? 0.5;
        const res = await job('detect', payload, transfer);
        S.detections = scale === 1 ? res.boxes : res.boxes.map((b) => ({
          ...b, x1: b.x1 / scale, y1: b.y1 / scale, x2: b.x2 / scale, y2: b.y2 / scale,
        }));
        S.inferMs = res.ms;
        const now = performance.now();
        if (warmingUp) {
          warmingUp = false; // first result includes shader compile — don't count it
        } else {
          S.fps = 0.8 * S.fps + 0.2 * (1000 / Math.max(1, now - lastT));
          els.fpsChip.textContent = `${S.fps.toFixed(1)} fps · ${S.inferMs.toFixed(0)} ms`;
        }
        lastT = now;
        renderDetList();
      } catch (err) {
        console.error(err);
        await sleep(500);
      }
    } else {
      await sleep(120);
    }
  }
}

async function depthLoop() {
  while (true) {
    const shouldRun = S.depthOn && S.detectorReady && !S.vlmBusy && frameCtx;
    if (shouldRun) {
      try {
        const { payload, transfer } = packImage(grabFrame());
        const res = await job('depth', payload, transfer);
        S.depthMap = res.depth;
        S.depthBitmap = await depthToBitmap(res.depth);
      } catch (err) {
        console.error(err);
        S.depthOn = false;
        els.depthToggle.checked = false;
        toast('Depth model failed: ' + err.message);
      }
    }
    await sleep(600);
  }
}

// magma-ish LUT
const DEPTH_LUT = (() => {
  const stops = [[13, 8, 32], [84, 22, 101], [170, 45, 96], [240, 106, 61], [252, 195, 106], [252, 253, 191]];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (stops.length - 1);
    const a = Math.floor(f), b = Math.min(stops.length - 1, a + 1), t = f - a;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(stops[a][c] * (1 - t) + stops[b][c] * t);
  }
  return lut;
})();

async function depthToBitmap(depth) {
  const { data, width, height } = depth;
  const img = new ImageData(width, height);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    img.data[i * 4] = DEPTH_LUT[v * 3];
    img.data[i * 4 + 1] = DEPTH_LUT[v * 3 + 1];
    img.data[i * 4 + 2] = DEPTH_LUT[v * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  return createImageBitmap(img);
}

function depthAt(x, y) {
  if (!S.depthMap) return null;
  const { data, width, height } = S.depthMap;
  const dx = Math.min(width - 1, Math.max(0, Math.round((x / S.captureW) * width)));
  const dy = Math.min(height - 1, Math.max(0, Math.round((y / S.captureH) * height)));
  return data[dy * width + dx];
}

// --- measurement / registration ---------------------------------------------------

function activeCalib() {
  const mode = els.calibMode.value;
  if (mode === 'plane' && S.calib.pxPerMm) {
    return { mode: 'plane', pxPerMm: S.calib.pxPerMm };
  }
  if (mode === 'pinhole') {
    const distMm = parseFloat(els.distanceCm.value) * 10;
    const hfov = parseFloat(els.hfovDeg.value);
    if (distMm > 0 && hfov > 10 && hfov < 170) {
      return { mode: 'pinhole', fxPx: focalPx(S.captureW, hfov), distanceMm: distMm };
    }
  }
  return { mode: 'none' };
}

// snapshot of the frame at click time — video keeps playing, but the crop sent
// to Qwen must come from the exact clicked frame
const clickSnap = document.createElement('canvas');

function snapClickFrame() {
  clickSnap.width = S.captureW; clickSnap.height = S.captureH;
  clickSnap.getContext('2d').drawImage(els.frame, 0, 0);
}

// Map a click to an object box: smallest detection box containing the point,
// else the nearest one, else a fixed region around the click. Never fails.
function boxForClick(x, y) {
  let best = null, bestArea = Infinity;
  for (const d of S.detections) {
    if (x >= d.x1 && x <= d.x2 && y >= d.y1 && y <= d.y2) {
      const a = (d.x2 - d.x1) * (d.y2 - d.y1);
      if (a < bestArea) { bestArea = a; best = d; }
    }
  }
  if (best) return best;
  let nearest = null, nd = Infinity;
  for (const d of S.detections) {
    const dist = Math.hypot((d.x1 + d.x2) / 2 - x, (d.y1 + d.y2) / 2 - y);
    if (dist < nd) { nd = dist; nearest = d; }
  }
  if (nearest && nd < Math.max(S.captureW, S.captureH) * 0.15) return nearest;
  const s = Math.round(Math.min(S.captureW, S.captureH) * 0.28);
  return {
    label: 'unidentified item', score: null,
    x1: Math.max(0, x - s / 2), y1: Math.max(0, y - s / 2),
    x2: Math.min(S.captureW, x + s / 2), y2: Math.min(S.captureH, y + s / 2),
  };
}

// Instant registration — no segmentation model in the path, so a click lands
// on the dashboard in milliseconds; Qwen identification streams in after.
function registerBox(box) {
  if (!frameCtx) return;
  const t0 = performance.now();
  snapClickFrame();
  const w = box.x2 - box.x1, h = box.y2 - box.y1;
  if (w < 4 || h < 4) return;
  const calib = activeCalib();
  const color = PALETTE[S.measurements.length % PALETTE.length];
  const centroid = [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];
  const measurement = {
    id: S.nextMeasureId++,
    name: box.label || 'object',
    corners: [[box.x1, box.y1], [box.x2, box.y1], [box.x2, box.y2], [box.x1, box.y2]],
    centroid,
    longPx: Math.max(w, h), shortPx: Math.min(w, h),
    longMm: pxToMm(Math.max(w, h), calib), shortMm: pxToMm(Math.min(w, h), calib),
    color,
    score: box.score,
    depth: depthAt(centroid[0], centroid[1]),
  };
  S.measurements.push(measurement);
  renderMeasureList();
  registerEvidence(measurement, calib);
  console.log(`[timing] click -> registered on dashboard in ${(performance.now() - t0).toFixed(1)}ms`);
}

// Two-point reference calibration: click both ends of an object of known length.
function addReferencePoint(point) {
  S.refPoints.push([point.x, point.y]);
  if (S.refPoints.length < 2) {
    els.calibStatus.textContent = 'First point set — now click the OTHER end of the reference';
    return;
  }
  const [a, b] = S.refPoints;
  const distPx = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const preset = currentPreset();
  S.refPoints = [];
  if (!preset.longMm || distPx < 8) {
    toast('Calibration failed — set a reference size and click two distinct points');
    els.calibStatus.textContent = 'Not calibrated';
    return;
  }
  S.calib = { mode: 'plane', pxPerMm: distPx / preset.longMm, refName: preset.name, refLine: [a, b] };
  S.clickMode = 'measure';
  els.btnSetRef.textContent = '◎ Re-set reference';
  els.calibStatus.innerHTML =
    `<span class="ok">✓ Calibrated:</span> ${S.calib.pxPerMm.toFixed(2)} px/mm via ${preset.name}` +
    `<br><span class="dim">valid for objects in the same plane as the reference</span>`;
  const calib = activeCalib();
  for (const m of S.measurements) {
    m.longMm = pxToMm(m.longPx, calib);
    m.shortMm = pxToMm(m.shortPx, calib);
  }
  renderMeasureList();
  toast(`Calibrated: ${S.calib.pxPerMm.toFixed(2)} px/mm via ${preset.name}`);
}

function currentPreset() {
  const preset = REFERENCE_PRESETS.find((p) => p.id === els.refPreset.value);
  if (preset.id !== 'custom') return preset;
  return {
    ...preset,
    name: 'Custom reference',
    longMm: parseFloat(els.customLong.value) || null,
    shortMm: parseFloat(els.customShort.value) || null,
  };
}

// --- panels ------------------------------------------------------------------------

let lastDetRender = 0;
function renderDetList() {
  const now = performance.now();
  if (now - lastDetRender < 250) return;
  lastDetRender = now;
  if (!S.detections.length) {
    els.detList.innerHTML = '<div class="empty">no objects above threshold</div>';
    return;
  }
  els.detList.innerHTML = '';
  S.detections.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'det-row';
    const wMm = pxToMm(d.x2 - d.x1, activeCalib());
    const depth = depthAt((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
    row.innerHTML =
      `<span class="det-dot" style="background:${labelColor(d.label)}"></span>` +
      `<span class="det-label">${d.label}</span>` +
      `<span class="det-meta">${(d.score * 100).toFixed(0)}%${wMm != null ? ' · ~' + formatMm(wMm) + ' wide' : ''}` +
      `${depth != null ? ' · near ' + Math.round((depth / 255) * 100) + '%' : ''}</span>`;
    const btn = document.createElement('button');
    btn.className = 'mini';
    btn.textContent = '➕ add';
    btn.title = 'Register this detection to the dashboard';
    btn.onclick = () => registerBox(d);
    row.appendChild(btn);
    els.detList.appendChild(row);
  });
}

function renderMeasureList() {
  const items = S.measurements;
  if (!items.length) {
    els.measureList.innerHTML = '<div class="empty">click any object in the view to register & measure it</div>';
    return;
  }
  els.measureList.innerHTML = '';
  for (const m of items) {
    const row = document.createElement('div');
    row.className = 'measure-row';
    const size = m.longMm != null ? formatSize(m.longMm, m.shortMm) : `${m.longPx.toFixed(0)} × ${m.shortPx.toFixed(0)} px (uncalibrated)`;
    row.innerHTML =
      `<span class="det-dot" style="background:${m.color}"></span>` +
      `<div class="measure-info"><div class="measure-name">#${m.id} ${m.name}</div>` +
      `<div class="measure-size">${size}${m.score ? ` <span class="dim">· conf ${(m.score * 100).toFixed(0)}%</span>` : ''}</div></div>`;
    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = '✕';
    del.onclick = () => {
      S.measurements = S.measurements.filter((x) => x !== m);
      renderMeasureList();
    };
    row.appendChild(del);
    els.measureList.appendChild(row);
  }
}

// --- VLM ---------------------------------------------------------------------------

function buildPrompt() {
  const custom = els.vlmQuestion.value.trim();
  const detLines = S.detections.map((d) => `- ${d.label} (${(d.score * 100).toFixed(0)}%)`).join('\n') || '- none';
  const calib = activeCalib();
  const mLines = S.measurements.map((m) =>
    `- #${m.id} ${m.name}: ${m.longMm != null ? formatSize(m.longMm, m.shortMm) : m.longPx.toFixed(0) + 'px long'}`,
  ).join('\n') || '- none yet';
  if (custom) {
    return `${custom}\n\n(Context — live detector found:\n${detLines}\nMeasured items:\n${mLines})`;
  }
  return `You are documenting a scene for an evidence log. Write a concise, factual evidence report based on the image:\n` +
    `1. EVIDENCE ITEMS — list each distinct visible object: type, color, condition, any markings.\n` +
    `2. ARRANGEMENT — brief spatial layout of the items.\n` +
    `3. OBSERVATIONS — anything unusual or noteworthy.\n\n` +
    `Cross-check against the live object detector (may be incomplete or wrong):\n${detLines}\n` +
    `Measured dimensions (${calib.mode === 'none' ? 'uncalibrated' : calib.mode + ' calibration'}):\n${mLines}\n` +
    `Keep it under 250 words. Use plain text with numbered sections, no markdown.`;
}

// --- evidence registry / dashboard -----------------------------------------------

function loadRegistry() {
  try { S.registry = JSON.parse(localStorage.getItem('ev.registry') || '[]'); }
  catch { S.registry = []; }
}

function saveRegistry() {
  try { localStorage.setItem('ev.registry', JSON.stringify(S.registry)); }
  catch { toast('Registry storage full — export & clear old items'); }
}

function thumbFromCorners(corners, maxSide) {
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  let x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
  const padX = (x2 - x1) * 0.12 + 6, padY = (y2 - y1) * 0.12 + 6;
  x1 = Math.max(0, x1 - padX); y1 = Math.max(0, y1 - padY);
  x2 = Math.min(S.captureW, x2 + padX); y2 = Math.min(S.captureH, y2 + padY);
  const w = x2 - x1, h = y2 - y1;
  if (w < 2 || h < 2) return null;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(clickSnap, x1, y1, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

function registerEvidence(m, calib) {
  const n = S.registry.reduce((mx, it) => Math.max(mx, parseInt(it.id.slice(3), 10) || 0), 0) + 1;
  const item = {
    id: 'EV-' + String(n).padStart(3, '0'),
    t: new Date().toISOString(),
    name: m.name,
    aiDesc: null,
    longMm: m.longMm, shortMm: m.shortMm,
    longPx: Math.round(m.longPx), shortPx: Math.round(m.shortPx),
    conf: m.score != null ? Math.round(m.score * 100) : null,
    calib: calib.mode,
    thumb: thumbFromCorners(m.corners, 120),
    notes: '',
  };
  S.registry.push(item);
  saveRegistry();
  updateDashCount();
  renderDashboard();
  const willIdentify = els.autoIdToggle.checked && els.apiKey.value.trim();
  toast(`${item.id} registered${item.longMm != null ? ' — ' + formatSize(item.longMm, item.shortMm) : ''}${willIdentify ? ' · Qwen identifying…' : ''}`);
  if (willIdentify) identifyItem(item, m);
}

async function identifyItem(item, m) {
  const key = els.apiKey.value.trim();
  if (!key) return;
  const crop = m ? thumbFromCorners(m.corners, 384) : item.thumb;
  if (!crop) return;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Evidence Live Detection Demo' },
      body: JSON.stringify({
        model: els.apiModel.value.trim() || 'qwen/qwen3-vl-235b-a22b-instruct',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: crop } },
            { type: 'text', text: 'Identify the main object in this photo for an evidence log. Reply with ONE line only: precise object name — color, material/condition, distinguishing marks. Be specific and factual.' },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    if (text) {
      item.aiDesc = text;
      // adopt Qwen's precise name for the item, on-screen and in the registry
      const shortName = text.split(/[—:\n]|\s-\s/)[0].trim();
      if (shortName.length >= 3 && shortName.length <= 42) {
        item.name = shortName;
        if (m) { m.name = shortName; renderMeasureList(); }
      }
      saveRegistry();
      renderDashboard();
      toast(`${item.id} · Qwen: ${(shortName || text).slice(0, 60)}`);
    }
  } catch (err) {
    console.warn('auto-ID failed for', item.id, err);
    toast(`${item.id}: VLM identification failed (${err.message})`);
  }
}

function updateDashCount() {
  els.dashCount.textContent = S.registry.length;
}

function renderDashboard() {
  if (els.dashboard.hidden) return;
  const sized = S.registry.filter((it) => it.longMm != null).length;
  els.dashStats.textContent =
    `${S.registry.length} item${S.registry.length === 1 ? '' : 's'} registered · ` +
    `${sized} with real-world size · stored locally in this browser`;
  els.dashTbody.innerHTML = '';
  for (const item of [...S.registry].reverse()) {
    const tr = document.createElement('tr');

    const tdThumb = document.createElement('td');
    if (item.thumb) {
      const img = document.createElement('img');
      img.src = item.thumb;
      img.className = 'dash-thumb';
      tdThumb.appendChild(img);
    }
    tr.appendChild(tdThumb);

    const tdId = document.createElement('td');
    tdId.className = 'dash-id';
    tdId.textContent = item.id;
    tr.appendChild(tdId);

    const tdName = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.value = item.name;
    nameInput.className = 'dash-edit';
    nameInput.onchange = () => { item.name = nameInput.value.trim() || item.name; saveRegistry(); };
    tdName.appendChild(nameInput);
    tr.appendChild(tdName);

    const tdAi = document.createElement('td');
    tdAi.className = 'dash-ai';
    tdAi.textContent = item.aiDesc || (els.apiKey.value.trim() ? '…' : '—');
    tr.appendChild(tdAi);

    const tdSize = document.createElement('td');
    tdSize.className = 'dash-size';
    tdSize.textContent = item.longMm != null
      ? formatSize(item.longMm, item.shortMm)
      : `${item.longPx}×${item.shortPx} px`;
    tr.appendChild(tdSize);

    const tdTime = document.createElement('td');
    tdTime.className = 'dash-time';
    tdTime.textContent = new Date(item.t).toLocaleString();
    tr.appendChild(tdTime);

    const tdNotes = document.createElement('td');
    const notesInput = document.createElement('input');
    notesInput.value = item.notes;
    notesInput.placeholder = 'notes…';
    notesInput.className = 'dash-edit';
    notesInput.onchange = () => { item.notes = notesInput.value; saveRegistry(); };
    tdNotes.appendChild(notesInput);
    tr.appendChild(tdNotes);

    const tdActions = document.createElement('td');
    const reId = document.createElement('button');
    reId.className = 'mini';
    reId.textContent = '🔁 ID';
    reId.title = 'Re-run VLM identification';
    reId.onclick = () => { item.aiDesc = null; renderDashboard(); identifyItem(item, null); };
    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = '✕';
    del.onclick = () => {
      S.registry = S.registry.filter((x) => x !== item);
      saveRegistry(); updateDashCount(); renderDashboard();
    };
    tdActions.appendChild(reId);
    tdActions.appendChild(del);
    tr.appendChild(tdActions);

    els.dashTbody.appendChild(tr);
  }
}

function blobDownload(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function exportCsv() {
  const cols = ['id', 'name', 'ai_identification', 'long_mm', 'short_mm', 'long_px', 'short_px', 'confidence_pct', 'calibration', 'registered_at', 'notes'];
  const rows = S.registry.map((it) => [
    it.id, it.name, it.aiDesc || '',
    it.longMm != null ? it.longMm.toFixed(1) : '', it.shortMm != null ? it.shortMm.toFixed(1) : '',
    it.longPx, it.shortPx, it.conf ?? it.maskIoU ?? '', it.calib, it.t, it.notes,
  ]);
  const csv = [cols, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  blobDownload(csv, `evidence_registry_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
}

function exportJson() {
  blobDownload(JSON.stringify(S.registry, null, 2),
    `evidence_registry_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}

// --- VLM --------------------------------------------------------------------------

function updateVlmUi() {
  els.vlmMode.value = S.vlmMode;
  const api = S.vlmMode === 'api';
  els.vlmApiUi.hidden = !api;
  els.vlmLocalUi.hidden = api;
  els.vlmControls.hidden = api ? !els.apiKey.value.trim() : S.vlmState !== 'ready';
}

function frameToJpeg(maxSide) {
  const scale = Math.min(1, maxSide / Math.max(S.captureW, S.captureH));
  const c = document.createElement('canvas');
  c.width = Math.round(S.captureW * scale);
  c.height = Math.round(S.captureH * scale);
  c.getContext('2d').drawImage(els.frame, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

async function analyzeApi() {
  const key = els.apiKey.value.trim();
  const model = els.apiModel.value.trim() || 'qwen/qwen3-vl-235b-a22b-instruct';
  if (!key || els.btnAnalyze.disabled) return;
  // API analysis is just a network call — detection keeps running
  els.btnAnalyze.disabled = true;
  els.btnAnalyze.textContent = '⏳ analyzing…';
  els.vlmOutput.textContent = '';
  els.vlmOutput.hidden = false;
  const t0 = performance.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Evidence Live Detection Demo',
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: frameToJpeg(1024) } },
            { type: 'text', text: buildPrompt() },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) {
            els.vlmOutput.textContent += delta;
            els.vlmOutput.scrollTop = els.vlmOutput.scrollHeight;
          }
        } catch { /* ignore keep-alive/partial lines */ }
      }
    }
    els.btnCopyReport.hidden = false;
    toast(`API analysis done in ${((performance.now() - t0) / 1000).toFixed(1)}s (${model.split('/').pop()})`);
  } catch (err) {
    els.vlmOutput.textContent += '\n[error] ' + err.message;
  } finally {
    els.btnAnalyze.disabled = false;
    els.btnAnalyze.textContent = '🔍 Analyze current frame';
  }
}

async function analyze() {
  if (S.vlmMode === 'api') return analyzeApi();
  if (S.vlmBusy || S.vlmState !== 'ready') return;
  S.vlmBusy = true;
  els.btnAnalyze.disabled = true;
  els.btnAnalyze.textContent = '⏳ analyzing…';
  els.vlmOutput.textContent = '';
  els.vlmOutput.hidden = false;
  try {
    const imgData = grabScaled(768);
    const res = await job('analyze', {
      image: { data: imgData.data.buffer, width: imgData.width, height: imgData.height },
      prompt: buildPrompt(),
    }, [imgData.data.buffer]);
    els.vlmOutput.textContent = res.text || els.vlmOutput.textContent;
    els.btnCopyReport.hidden = false;
    toast(`Analysis done in ${(res.ms / 1000).toFixed(1)}s`);
  } catch (err) {
    els.vlmOutput.textContent += '\n[error] ' + err.message;
  } finally {
    S.vlmBusy = false;
    els.btnAnalyze.disabled = false;
    els.btnAnalyze.textContent = '🔍 Analyze current frame';
  }
}

// --- snapshot export -----------------------------------------------------------------

function snapshot() {
  const c = document.createElement('canvas');
  const headerH = 56;
  c.width = S.captureW;
  c.height = S.captureH + headerH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(els.frame, 0, headerH);
  ctx.drawImage(els.overlay, 0, headerH);
  ctx.fillStyle = '#22d3ee';
  ctx.font = 'bold 16px ui-monospace, monospace';
  ctx.fillText('EVIDENCE // LIVE DETECTION & MEASUREMENT', 12, 22);
  ctx.fillStyle = '#9fb0c0';
  ctx.font = '12px ui-monospace, monospace';
  const calib = activeCalib();
  const calibText = calib.mode === 'plane'
    ? `plane-calibrated ${calib.pxPerMm.toFixed(2)} px/mm (${S.calib.refName})`
    : calib.mode === 'pinhole' ? `pinhole model @ ${els.distanceCm.value} cm, hFOV ${els.hfovDeg.value}°` : 'uncalibrated';
  ctx.fillText(`${new Date().toISOString()}  ·  ${calibText}  ·  RF-DETR + DepthAnythingV2 + Qwen3-VL (in-browser)`, 12, 42);
  c.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `evidence_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

// --- UI wiring ---------------------------------------------------------------------

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

function stageCoords(e) {
  const rect = els.overlay.getBoundingClientRect();
  return {
    x: Math.round(((e.clientX - rect.left) / rect.width) * S.captureW),
    y: Math.round(((e.clientY - rect.top) / rect.height) * S.captureH),
  };
}

function wireUi() {
  els.overlay.addEventListener('click', (e) => {
    if (!S.detectorReady) return;
    const point = stageCoords(e);
    if (S.clickMode === 'reference') addReferencePoint(point);
    else registerBox(boxForClick(point.x, point.y));
  });

  els.btnSnapshot.onclick = snapshot;
  els.btnClear.onclick = () => { S.measurements = []; renderMeasureList(); };

  els.threshold.oninput = () => {
    S.threshold = parseFloat(els.threshold.value);
    els.thresholdVal.textContent = S.threshold.toFixed(2);
  };

  els.depthToggle.onchange = () => {
    S.depthOn = els.depthToggle.checked;
    if (!S.depthOn) { S.depthBitmap = null; S.depthMap = null; }
  };

  els.calibMode.onchange = () => {
    const m = els.calibMode.value;
    els.planeUi.hidden = m !== 'plane';
    els.pinholeUi.hidden = m !== 'pinhole';
    if (m !== 'plane') S.clickMode = 'measure';
  };

  els.refPreset.onchange = () => {
    els.customDims.hidden = els.refPreset.value !== 'custom';
  };

  els.btnSetRef.onclick = () => {
    S.clickMode = S.clickMode === 'reference' ? 'measure' : 'reference';
    S.refPoints = [];
    els.btnSetRef.textContent = S.clickMode === 'reference'
      ? '… click the TWO ends of the reference'
      : '◎ Set reference (2 clicks)';
  };

  els.cameraSel.onchange = async () => {
    try { await startCamera({ deviceId: els.cameraSel.value }); }
    catch (err) { toast('Camera switch failed: ' + err.message); }
  };

  els.btnFlip.onclick = async () => {
    if (!els.video.srcObject || els.btnFlip.disabled) return;
    els.btnFlip.disabled = true;
    const prevId = currentDeviceId;
    S.facing = S.facing === 'user' ? 'environment' : 'user';
    try {
      // ask for the opposite facing; if the browser hands back the same camera
      // (laptops usually don't report facing), cycle to the next device instead
      const newId = await startCamera({ facing: S.facing });
      if (newId === prevId) {
        const ids = [...els.cameraSel.options].map((o) => o.value);
        if (ids.length > 1) {
          await startCamera({ deviceId: ids[(ids.indexOf(prevId) + 1) % ids.length] });
        } else {
          toast('Only one camera available on this device');
        }
      }
    } catch (err) {
      toast('Camera flip failed: ' + err.message);
      try { await startCamera({ deviceId: prevId }); } catch { /* keep whatever works */ }
    } finally {
      els.btnFlip.disabled = false;
    }
  };

  // VLM mode: config.local.js provides defaults, localStorage persists edits
  const CFG = window.EVIDENCE_CONFIG || {};
  els.apiKey.value = localStorage.getItem('ev.orKey') ?? CFG.openrouterKey ?? '';
  els.apiModel.value = localStorage.getItem('ev.orModel') || CFG.openrouterModel || 'qwen/qwen3-vl-235b-a22b-instruct';
  S.vlmMode = localStorage.getItem('ev.vlmMode') || (els.apiKey.value ? 'api' : 'local');
  updateVlmUi();

  els.vlmMode.onchange = () => {
    S.vlmMode = els.vlmMode.value;
    localStorage.setItem('ev.vlmMode', S.vlmMode);
    updateVlmUi();
  };
  els.apiKey.oninput = () => {
    localStorage.setItem('ev.orKey', els.apiKey.value.trim());
    updateVlmUi();
  };
  els.apiModel.oninput = () => localStorage.setItem('ev.orModel', els.apiModel.value.trim());

  els.btnLoadVlm.onclick = () => {
    els.btnLoadVlm.disabled = true;
    els.vlmProgress.hidden = false;
    job('load-vlm').catch((err) => {
      els.btnLoadVlm.disabled = false;
      els.vlmProgressText.textContent = 'Load failed: ' + err.message;
    });
  };

  els.btnAnalyze.onclick = analyze;
  els.btnCopyReport.onclick = async () => {
    await navigator.clipboard.writeText(els.vlmOutput.textContent);
    toast('Report copied to clipboard');
  };

  // detector size
  els.detModel.onchange = async () => {
    const size = els.detModel.value;
    localStorage.setItem('ev.detSize', size);
    S.detSize = size;
    S.detectorReady = false;
    els.detChip.textContent = `loading RF-DETR ${size}…`;
    els.detChip.classList.remove('chip-ok');
    try {
      await job('set-detector', { size });
      S.detectorReady = true;
      els.detChip.textContent = `RF-DETR ${size} ready`;
      els.detChip.classList.add('chip-ok');
    } catch (err) {
      toast('Detector switch failed: ' + err.message);
    }
  };

  // dashboard
  els.btnDashboard.onclick = () => {
    els.dashboard.hidden = !els.dashboard.hidden;
    renderDashboard();
  };
  els.btnDashClose.onclick = () => { els.dashboard.hidden = true; };
  els.btnExportJson.onclick = exportJson;
  els.btnExportCsv.onclick = exportCsv;
  els.btnClearRegistry.onclick = () => {
    if (!S.registry.length) return;
    if (confirm(`Delete all ${S.registry.length} registered items? Export first if you need them.`)) {
      S.registry = [];
      saveRegistry(); updateDashCount(); renderDashboard();
    }
  };
  els.autoIdToggle.checked = localStorage.getItem('ev.autoId') !== '0';
  els.autoIdToggle.onchange = () => localStorage.setItem('ev.autoId', els.autoIdToggle.checked ? '1' : '0');
}

// --- boot ---------------------------------------------------------------------------

async function main() {
  S.detSize = localStorage.getItem('ev.detSize') || 'nano';
  els.detModel.value = S.detSize;
  loadRegistry();
  updateDashCount();
  wireUi();
  renderMeasureList();
  // populate reference presets
  for (const p of REFERENCE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.longMm ? ` — ${p.longMm}×${p.shortMm} mm` : '');
    els.refPreset.appendChild(opt);
  }
  setLoadStatus(`Loading RF-DETR ${S.detSize}…`);
  worker.postMessage({ type: 'init', detector: S.detSize });
  try {
    await startCamera({ facing: S.facing });
  } catch (err) {
    els.stageMsg.textContent = '⚠ Camera unavailable: ' + err.message +
      '\nGrant camera permission and reload (localhost or HTTPS required).';
    els.stageMsg.hidden = false;
    return;
  }
  requestAnimationFrame(render);
  detectLoop();
  depthLoop();
}

main();
