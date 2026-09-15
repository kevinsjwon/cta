#!/usr/bin/env node
/**
 * tool-bands — 한 부위의 **띠 구조**를 행마다 뽑는다 (귀 재구성 파라미터 산출용)
 *
 * 밝기 임계 = 그 행 최대값의 78%. 어두움/밝음이 교대하는 구간을 내보낸다.
 * 너굴 귀는 [바깥선 / 크림 / 귓속 / 크림 / 안쪽선] 5개가 나온다.
 * 이 값의 **행별 변화**로 귓속이 언제 닫히는지, 중심이 어디로 이동하는지를 정한다(§8.6).
 *
 * 사용: node bin/tool-bands.mjs <파일> <x0> <x1> [step] [rows]
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');

const [f, X0, X1, STEP, ROWS] = process.argv.slice(2);
const x0 = +X0, x1 = +X1, step = +(STEP || 3), rows = +(ROWS || 27);
const [W, H] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', f], { encoding: 'utf8' }).trim().split('x').map(Number);
const b = execFileSync(FFMPEG, ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { maxBuffer: W * H * 4 + 9000 });
const lum = (x, y) => { const o = (y * W + x) * 4; return b[o + 3] <= 32 ? null : 0.3 * b[o] + 0.6 * b[o + 1] + 0.1 * b[o + 2]; };

console.log(`${f}  ${W}x${H}  x${x0}-${x1}`);
for (let y = 0; y < rows; y += step) {
  let L = -1, R = -1;
  for (let x = x0; x <= x1; x++) if (lum(x, y) != null) { if (L < 0) L = x; R = x; }
  if (L < 0) { console.log(` y=${String(y).padStart(2)}  없음`); continue; }
  let mx = 0;
  for (let x = L; x <= R; x++) { const v = lum(x, y); if (v != null && v > mx) mx = v; }
  const th = mx * 0.78;
  const seg = []; let cur = null;
  for (let x = L; x <= R; x++) {
    const v = lum(x, y), br = v != null && v >= th;
    if (!cur || cur.b !== br) { if (cur) seg.push(cur); cur = { b: br, s: x, e: x }; } else cur.e = x;
  }
  if (cur) seg.push(cur);
  const m = [];
  for (const g of seg) {
    if (m.length && (g.e - g.s + 1) < 6) m[m.length - 1].e = g.e;
    else if (m.length && m[m.length - 1].b === g.b) m[m.length - 1].e = g.e;
    else m.push({ ...g });
  }
  console.log(` y=${String(y).padStart(2)} [${L}-${R}]  ${m.map(s => (s.b ? '밝' : '어') + s.s + '-' + s.e + '(' + (s.e - s.s + 1) + ')').join(' ')}`);
}
