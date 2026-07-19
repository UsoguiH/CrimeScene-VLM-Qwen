// qwen.js — Qwen3-VL vision calls via OpenRouter: open-vocabulary grounding
// (find-by-text), full-scene scanning, and structured evidence records.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';

async function chat({ apiKey, model, image, prompt, maxTokens = 600 }) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Evidence Live Detection Demo',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

// Tolerate markdown fences, prose around the JSON, and object wrappers.
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const starts = ['[', '{'].map((c) => body.indexOf(c)).filter((i) => i !== -1);
  if (!starts.length) throw new Error('no JSON in model reply');
  const slice = body.slice(Math.min(...starts));
  const end = Math.max(slice.lastIndexOf(']'), slice.lastIndexOf('}'));
  return JSON.parse(slice.slice(0, end + 1));
}

// Normalize one grounding entry to {label, box:[x1,y1,x2,y2]}.
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const box = e.bbox_2d || e.bbox || e.box || e.bbox2d;
  if (!Array.isArray(box) || box.length !== 4 || box.some((v) => typeof v !== 'number')) return null;
  let [x1, y1, x2, y2] = box;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return { label: String(e.label || e.name || e.object || 'object').slice(0, 48), box: [x1, y1, x2, y2] };
}

function asEntryArray(parsed) {
  const arr = Array.isArray(parsed) ? parsed : parsed.objects || parsed.results || parsed.detections || [];
  return (Array.isArray(arr) ? arr : []).map(normalizeEntry).filter(Boolean);
}

// Convert model coordinates to capture-frame pixels. Qwen3-VL reports 0-1000
// normalized boxes; some model revisions answer in absolute pixels of the sent
// image instead — detect that case and rescale from the sent dimensions.
export function toPixels(entries, capW, capH, sentW, sentH) {
  const maxVal = Math.max(0, ...entries.flatMap((e) => e.box));
  const absolute = sentW && maxVal > 1000;
  return entries.map(({ label, box: [x1, y1, x2, y2] }) => {
    const sx = absolute ? capW / sentW : capW / 1000;
    const sy = absolute ? capH / sentH : capH / 1000;
    return {
      label,
      x1: Math.max(0, x1 * sx), y1: Math.max(0, y1 * sy),
      x2: Math.min(capW, x2 * sx), y2: Math.min(capH, y2 * sy),
    };
  });
}

const GROUND_RULES =
  'Reply with JSON only — no prose, no markdown fence. ' +
  'Format: [{"bbox_2d":[x1,y1,x2,y2],"label":"<short name>"}] ' +
  'with coordinates normalized to 0-1000, top-left origin.';

// Find every instance of a free-text description in the image.
export async function ground({ apiKey, model, image, query }) {
  const text = await chat({
    apiKey, model, image, maxTokens: 700,
    prompt: `Locate every instance of: ${query}. ${GROUND_RULES} Return [] if none are present.`,
  });
  return asEntryArray(extractJson(text));
}

// Locate every distinct physical object in the scene.
export async function scanScene({ apiKey, model, image }) {
  const text = await chat({
    apiKey, model, image, maxTokens: 1400,
    prompt: 'Locate every distinct physical object in this image ' +
      '(ignore walls, floors, ceilings and other background surfaces). ' + GROUND_RULES,
  });
  return asEntryArray(extractJson(text));
}

// Structured evidence record for one object crop.
export async function identifyStructured({ apiKey, model, image }) {
  const text = await chat({
    apiKey, model, image, maxTokens: 300,
    prompt: 'Describe the main object in this photo for an evidence log. Reply with JSON only, no markdown fence: ' +
      '{"name":"<precise object name, max 6 words>",' +
      '"category":"<one of: weapon, tool, electronics, document, container, clothing, personal item, furniture, animal, substance, other>",' +
      '"color":"<dominant colors>","material":"<apparent material>","condition":"<new/worn/damaged/etc>",' +
      '"markings":"<visible marks, damage or distinguishing features, empty string if none>",' +
      '"visible_text":"<any readable text, labels or serial numbers, empty string if none>"}',
  });
  const o = extractJson(text);
  const s = (v, n = 80) => String(v ?? '').slice(0, n);
  return {
    name: s(o.name, 60),
    category: s(o.category, 24).toLowerCase() || 'other',
    color: s(o.color),
    material: s(o.material),
    condition: s(o.condition),
    markings: s(o.markings, 160),
    visible_text: s(o.visible_text, 160),
  };
}
