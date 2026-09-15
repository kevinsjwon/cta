#!/usr/bin/env node
/**
 * tool-despeck — 컷아웃에 박힌 **작은 순백 잔재**를 주변 색으로 메운다
 *
 * 체커 제거 뒤 외곽에 순백 조각이 남는 일이 있다(실측: 너굴 뒤통수 x459-476 y0-8, 66px).
 * 그대로 두면 귀 재구성이 그 조각을 끝까지 늘려 **하얀 쐐기**를 만든다.
 *
 * ⚠️ 단순히 "흰색이면 지운다" 는 안 된다. **흰 토끼의 몸통 전체가 날아간다.**
 *    → 근사 무채색·고휘도 픽셀을 덩어리로 묶고, **전체 알파 면적의 --max(기본 0.2%) 이하**
 *      인 덩어리만 처리한다. 캐릭터 본체는 수십 % 라 항상 안전하다.
 * ⚠️ 알파를 0 으로 지우지 말 것. 그 자리가 구멍이 되어 재구성이 찢어진다(§8.6).
 *    **아래쪽 성한 픽셀 색으로 메운다.**
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => { try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {} return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'); })();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');
const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? +a[i + 1] : undefined; };
const files = a.filter((v, i) => !v.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
const [IN, OUT] = files;
const MAXFRAC = arg('max') ?? 0.002;
// 205/26 = 옅은 회백 조각까지 잡는 값. 크기 상한이 흰 토끼 몸통(수십 %)을 보호한다.
const LUM = arg('lum') ?? 225, SAT = arg('sat') ?? 14;
const EDGE = arg('edge') ?? 10;

const [W, H] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', IN], { encoding: 'utf8' }).trim().split('x').map(Number);
const b = Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', IN,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: W * H * 4 + 8192 }));

const isW = i => { const o = i * 4; if (b[o + 3] <= 32) return false;
  const mx = Math.max(b[o], b[o + 1], b[o + 2]), mn = Math.min(b[o], b[o + 1], b[o + 2]);
  return mn > LUM && mx - mn < SAT; };
let alphaN = 0;
for (let i = 0; i < W * H; i++) if (b[i * 4 + 3] > 32) alphaN++;
const cap = Math.max(40, alphaN * MAXFRAC);

const seen = new Uint8Array(W * H);
let fixed = 0, groups = 0;
for (let i = 0; i < W * H; i++) {
  if (seen[i] || !isW(i)) continue;
  const st = [i], px = []; seen[i] = 1;
  while (st.length) {
    const p = st.pop(); px.push(p);
    const x = p % W, y = (p - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (seen[q] || !isW(q)) continue;
      seen[q] = 1; st.push(q);
    }
    if (px.length > cap) break;
  }
  if (px.length > cap) continue;          // 캐릭터 본체(흰 토끼 등) → 손대지 않는다
  // ⚠️ 크기 조건만으로는 부족하다. 임계를 낮추면 **흰 토끼 몸통 안쪽의 작은 조각들까지**
  //    잡혀 세로 줄무늬로 망가진다(실측). 잔재는 항상 **알파 경계에 붙어** 있으므로
  //    경계에서 EDGE px 이내인 덩어리만 처리한다.
  const nearEdge = px.some(p => {
    const x = p % W, y = (p - x) / W;
    for (let dy = -EDGE; dy <= EDGE; dy++) for (let dx = -EDGE; dx <= EDGE; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return true;
      if (b[(ny * W + nx) * 4 + 3] <= 32) return true;
    }
    return false;
  });
  if (!nearEdge) continue;
  groups++;
  // ⚠️ 알파를 지우지 말 것. 구멍이 생기면 이후 단계가 "잘린 행"으로 오판한다(실측).
  //    채울 색을 못 찾으면 그냥 둔다 — 남은 잔재는 16-rebuild-ears 의 despeck 이 처리한다.
  for (const p of px) {
    const x = p % W, y = (p - x) / W, o = p * 4;
    for (let yy = y + 1; yy < H; yy++) {
      const i2 = yy * W + x, q = i2 * 4;
      if (b[q + 3] > 32 && !isW(i2)) { b[o] = b[q]; b[o + 1] = b[q + 1]; b[o + 2] = b[q + 2]; fixed++; break; }
    }
  }
}
execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', '1', OUT], { input: b });
console.log(`  ${IN.split('/').pop()} → 흰 잔재 ${groups}덩어리 ${fixed}px 메움`);
