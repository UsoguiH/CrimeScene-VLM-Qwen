// Comprehensive E2E verification for the Evidence demo (SAM-free architecture).
// Headline requirement: a click registers to the dashboard in UNDER 2 SECONDS.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const APP_DIR = new URL('.', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');

// self-host the app server so the test never depends on an external process
const serverUp = async () => {
  try { return (await fetch('http://localhost:8000/', { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
};
let serverProc = null;
if (!(await serverUp())) {
  serverProc = spawn(process.execPath, [`${APP_DIR}/server.mjs`], { stdio: 'ignore' });
  for (let i = 0; i < 20 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 300));
}
if (!(await serverUp())) {
  console.log('FAIL could not start app server');
  process.exit(1);
}
console.log(`server: ${serverProc ? 'self-hosted for this test' : 'already running'}`);

const results = [];
const errors = [];
const timingLogs = [];
const check = (name, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`;
  results.push(line);
  console.log(line); // print live so partial results survive process kills
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  userDataDir: './edge-profile', // persists model cache across test runs
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    // real photo (two cats + two remotes on a sofa) as the camera feed
    `--use-file-for-fake-video-capture=${process.cwd().replace(/\\/g, '/')}/testcam.mjpeg`,
    '--enable-unsafe-webgpu',
    '--enable-features=WebGPU',
    '--no-first-run',
  ],
});

const clickStage = async (page, fx, fy) => {
  // raw mouse coords don't auto-scroll — bring the stage into view first
  await page.evaluate(() => document.getElementById('stage').scrollIntoView({ block: 'start' }));
  await new Promise((r) => setTimeout(r, 120));
  const box = await (await page.$('#overlay')).boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
};
const measureRows = (page) =>
  page.evaluate(() => document.querySelectorAll('#measure-list .measure-row').length);
const dashCount = (page) =>
  page.evaluate(() => parseInt(document.getElementById('dash-count').textContent, 10) || 0);

// click at (fx, fy) and time click -> dashboard-count>=target, clock starting AT the click
const timedRegister = async (page, fx, fy, target) => {
  await page.evaluate(() => document.getElementById('stage').scrollIntoView({ block: 'start' }));
  await new Promise((r) => setTimeout(r, 120));
  const box = await (await page.$('#overlay')).boundingBox();
  const t0 = Date.now();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  const ok = await page
    .waitForFunction((n) => parseInt(document.getElementById('dash-count').textContent, 10) >= n,
      { timeout: 5000 }, target)
    .then(() => true).catch(() => false);
  return { ok, ms: Date.now() - t0 };
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 }); // two-column layout, no scroll traps
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
    if (m.text().startsWith('[timing]')) timingLogs.push(m.text());
  });

  // deterministic start — but only wipe once so the reload-persistence test works
  await page.evaluateOnNewDocument(() => {
    try {
      if (!sessionStorage.getItem('e2e-init')) {
        localStorage.setItem('ev.autoId', '1'); // exercise the real Qwen auto-ID path
        localStorage.setItem('ev.detSize', 'nano');
        localStorage.removeItem('ev.registry');
        localStorage.removeItem('ev.vlmMode');
        sessionStorage.setItem('e2e-init', '1');
      }
    } catch {}
  });

  // ---------- 1. boot ----------
  await page.goto('http://localhost:8000', { waitUntil: 'load', timeout: 20000 });
  check('page loads', true);
  check('camera started', await page
    .waitForFunction(() => document.getElementById('stage-msg')?.hidden === true, { timeout: 20000 })
    .then(() => true).catch(() => false));
  check('freeze feature absent', await page.evaluate(() => !document.getElementById('btn-freeze')));

  // ---------- 2. dashboard lifecycle ----------
  check('dashboard hidden at load', await page.evaluate(
    () => getComputedStyle(document.getElementById('dashboard')).display === 'none'));
  await page.click('#btn-dashboard');
  check('dashboard opens', await page.evaluate(
    () => getComputedStyle(document.getElementById('dashboard')).display !== 'none'));
  await page.click('#btn-dash-close');
  check('dashboard closes', await page.evaluate(
    () => getComputedStyle(document.getElementById('dashboard')).display === 'none'));

  // ---------- 3. detection ----------
  check('detector ready', await page
    .waitForFunction(() => document.getElementById('chip-detector')?.textContent.includes('ready'), { timeout: 240000 })
    .then(() => true).catch(() => false));
  const backend = await page.evaluate(() => document.getElementById('chip-backend').textContent);
  check('WebGPU backend active', /WebGPU/.test(backend), backend);
  check('objects detected on live video', await page
    .waitForFunction(() => document.querySelectorAll('#detections-list .det-row').length > 0, { timeout: 120000 })
    .then(() => true).catch(() => false));
  const detLabels = await page.evaluate(() =>
    [...document.querySelectorAll('#detections-list .det-label')].map((e) => e.textContent).join(', '));
  check('labels match scene (cats/remotes)', /cat|remote|couch/i.test(detLabels), detLabels);
  const fpsOk = await page
    .waitForFunction(() => /^\d+(\.\d+)? fps/.test(document.getElementById('chip-fps').textContent), { timeout: 180000 })
    .then(() => true).catch(() => false);
  const fpsText = await page.evaluate(() => document.getElementById('chip-fps').textContent);
  check('fps counter valid (no Infinity/NaN)', fpsOk && !/Infinity|NaN/.test(fpsText), fpsText);

  // ---------- 4. two-click reference calibration (model-free, instant) ----------
  await page.select('#ref-preset', 'credit-card');
  await page.click('#btn-set-ref');
  await clickStage(page, 0.28, 0.50);
  await clickStage(page, 0.47, 0.50);
  check('two-click calibration instant', await page
    .waitForFunction(() => /Calibrated/.test(document.getElementById('calib-status').textContent), { timeout: 5000 })
    .then(() => true).catch(() => false),
  await page.evaluate(() => document.getElementById('calib-status').textContent.slice(0, 60)));

  // ---------- 5. THE HEADLINE: click -> dashboard in < 2 seconds ----------
  const rowsBefore = await measureRows(page);
  const r1 = await timedRegister(page, 0.72, 0.55, 1); // right cat
  check('click registered to dashboard', r1.ok, `count=${await dashCount(page)}`);
  check('REGISTERED WITHIN 2 SECONDS', r1.ok && r1.ms <= 2000, `${r1.ms}ms (limit 2000ms)`);
  check('measurement row added', (await measureRows(page)) > rowsBefore);
  const sizeText = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#measure-list .measure-size')];
    return rows.at(-1)?.textContent || '';
  });
  check('size reported in real units (cm/mm)', /cm|mm/.test(sizeText), sizeText.slice(0, 50));

  // ---------- 6. Qwen identification on the dashboard ----------
  await page.click('#btn-dashboard');
  check('dashboard row exists', await page.evaluate(
    () => document.querySelectorAll('#dash-tbody tr').length > 0));
  const aiOk = await page
    .waitForFunction(() => {
      const c = document.querySelector('#dash-tbody .dash-ai');
      const t = c ? c.textContent.trim() : '';
      return t.length > 5 && t !== '…';
    }, { timeout: 60000 }).then(() => true).catch(() => false);
  const aiText = await page.evaluate(
    () => document.querySelector('#dash-tbody .dash-ai')?.textContent.trim().slice(0, 90) || '(empty)');
  check('Qwen identified item on dashboard', aiOk, aiText);
  const errsBefore = errors.length;
  await page.click('#btn-export-json');
  await page.click('#btn-export-csv');
  await new Promise((r) => setTimeout(r, 800));
  check('JSON/CSV export click no errors', errors.length === errsBefore);
  await page.click('#btn-dash-close');

  // ---------- 7. second item, also < 2s ----------
  const r2 = await timedRegister(page, 0.35, 0.85, 2); // remotes at the bottom
  check('second item < 2s', r2.ok && r2.ms <= 2000, `${r2.ms}ms, count=${await dashCount(page)}`);

  // in-app latency proof from the [timing] console instrumentation
  const appTimings = timingLogs.slice();
  check('in-app click->register latency logged', appTimings.length >= 2, appTimings.join(' | '));

  // ---------- 8. depth overlay ----------
  await page.click('#depth-toggle');
  check('depth overlay renders', await page
    .waitForFunction(() => {
      const c = document.getElementById('overlay');
      const d = c.getContext('2d').getImageData(1, 1, 3, 3).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    }, { timeout: 240000 }).then(() => true).catch(() => false));
  await page.click('#depth-toggle');

  // ---------- 9. full-frame Qwen analysis (streaming API) ----------
  check('VLM API mode ready without load', await page.evaluate(
    () => getComputedStyle(document.getElementById('vlm-controls')).display !== 'none'));
  await page.click('#btn-analyze');
  check('evidence report streams in', await page
    .waitForFunction(() => document.getElementById('vlm-output').textContent.length > 80, { timeout: 120000 })
    .then(() => true).catch(() => false),
  await page.evaluate(() => document.getElementById('vlm-output').textContent.trim().slice(0, 80)));
  check('report finishes (copy button shown)', await page
    .waitForFunction(() => !document.getElementById('btn-copy-report').hidden, { timeout: 120000 })
    .then(() => true).catch(() => false));

  // ---------- 10. camera flip + snapshot ----------
  await page.click('#btn-flip');
  const flipOutcome = await page
    .waitForFunction(() => {
      const t = document.getElementById('toast');
      if (t.classList.contains('show') && /Only one camera|failed/i.test(t.textContent)) return t.textContent;
      return false;
    }, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => 'no-toast');
  check('flip handles single camera gracefully', flipOutcome !== 'no-toast' && !/failed/i.test(String(flipOutcome)), String(flipOutcome));
  const errsBeforeSnap = errors.length;
  await page.click('#btn-snapshot');
  await new Promise((r) => setTimeout(r, 1200));
  check('snapshot export no errors', errors.length === errsBeforeSnap);

  // ---------- 11. persistence across reload ----------
  const countBeforeReload = await dashCount(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('dash-count') !== null, { timeout: 15000 });
  const countAfterReload = await dashCount(page);
  check('registry persists across reload', countAfterReload === countBeforeReload && countAfterReload > 0,
    `${countBeforeReload} -> ${countAfterReload}`);
} catch (err) {
  check('test run completed', false, err.message.slice(0, 200));
} finally {
  await browser.close();
  serverProc?.kill();
}

console.log(`\nCONSOLE/PAGE ERRORS (${errors.length}):`);
console.log(errors.slice(0, 20).join('\n') || '(none)');
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
