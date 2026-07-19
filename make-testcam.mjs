// Builds testcam.mjpeg — the fake-camera feed used by test-e2e.mjs.
// Usage: node make-testcam.mjs
import { writeFileSync } from 'node:fs';

const res = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg');
if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
const jpeg = Buffer.from(await res.arrayBuffer());
writeFileSync(new URL('./testcam.mjpeg', import.meta.url), Buffer.concat(Array(10).fill(jpeg)));
console.log(`testcam.mjpeg written (${jpeg.length * 10} bytes)`);
