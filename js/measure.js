// measure.js — pure measurement math: mask -> edge points -> convex hull ->
// min-area rotated rect (rotating calipers), plus real-world calibration models.

export const REFERENCE_PRESETS = [
  { id: 'credit-card', name: 'Credit card (ISO ID-1)', longMm: 85.6, shortMm: 53.98 },
  { id: 'a4', name: 'A4 paper', longMm: 297, shortMm: 210 },
  { id: 'letter', name: 'US Letter paper', longMm: 279.4, shortMm: 215.9 },
  { id: 'cd', name: 'CD / DVD disc', longMm: 120, shortMm: 120 },
  { id: 'banknote-usd', name: 'US banknote', longMm: 155.96, shortMm: 66.29 },
  { id: 'custom', name: 'Custom size…', longMm: null, shortMm: null },
];

// Collect at most 2 points per row (min/max x of the mask) — enough for an
// exact convex hull at a fraction of the point count.
export function maskToEdgePoints(mask, width, height) {
  const pts = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let minX = -1, maxX = -1;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) { if (minX === -1) minX = x; maxX = x; }
    }
    if (minX !== -1) {
      pts.push([minX, y]);
      if (maxX !== minX) pts.push([maxX, y]);
    }
  }
  return pts;
}

export function maskArea(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

export function maskCentroid(mask, width, height) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) { sx += x; sy += y; n++; }
    }
  }
  return n ? [sx / n, sy / n] : [width / 2, height / 2];
}

// Monotone-chain convex hull. Points: [[x,y], ...] -> hull in CCW order.
export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Minimum-area enclosing rectangle over the convex hull (rotating calipers).
// Returns { corners: [[x,y]x4], long, short, angle } in image coordinates.
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 0) return null;
  if (hull.length === 1) {
    const p = hull[0];
    return { corners: [p, p, p, p], long: 0, short: 0, angle: 0 };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p1 = hull[i], p2 = hull[(i + 1) % hull.length];
    const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * ca + y * sa;   // rotate by -angle
      const ry = -x * sa + y * ca;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    const w = maxX - minX, h = maxY - minY;
    if (!best || w * h < best.area) best = { area: w * h, angle, ca, sa, minX, maxX, minY, maxY, w, h };
  }
  const { ca, sa } = best;
  const unrot = (rx, ry) => [rx * ca - ry * sa, rx * sa + ry * ca];
  const corners = [
    unrot(best.minX, best.minY),
    unrot(best.maxX, best.minY),
    unrot(best.maxX, best.maxY),
    unrot(best.minX, best.maxY),
  ];
  return {
    corners,
    long: Math.max(best.w, best.h),
    short: Math.min(best.w, best.h),
    angle: best.angle,
  };
}

// --- Calibration models -----------------------------------------------------

// Pinhole focal length in pixels from horizontal field of view.
export function focalPx(frameWidthPx, hfovDeg) {
  return (frameWidthPx / 2) / Math.tan(((hfovDeg * Math.PI) / 180) / 2);
}

// Derive px-per-mm from a segmented reference object's min-area rect.
// Uses both dimensions when the preset defines both (more robust).
export function planeCalibration(rect, longMm, shortMm) {
  const ratios = [];
  if (longMm && rect.long > 4) ratios.push(rect.long / longMm);
  if (shortMm && rect.short > 4) ratios.push(rect.short / shortMm);
  if (!ratios.length) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

// Convert a pixel length to millimetres under the active calibration.
// calib: { mode: 'plane'|'pinhole'|'none', pxPerMm?, fxPx?, distanceMm? }
export function pxToMm(px, calib) {
  if (calib.mode === 'plane' && calib.pxPerMm > 0) return px / calib.pxPerMm;
  if (calib.mode === 'pinhole' && calib.fxPx > 0 && calib.distanceMm > 0) {
    return (px * calib.distanceMm) / calib.fxPx;
  }
  return null;
}

export function formatMm(mm) {
  if (mm == null) return null;
  if (mm >= 1000) return (mm / 1000).toFixed(2) + ' m';
  if (mm >= 100) return (mm / 10).toFixed(1) + ' cm';
  return mm.toFixed(1) + ' mm';
}

export function formatSize(longMm, shortMm) {
  if (longMm == null) return null;
  return `${formatMm(longMm)} × ${formatMm(shortMm)}`;
}
