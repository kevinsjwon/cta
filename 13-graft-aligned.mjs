#!/usr/bin/env node
/**
 * 13-graft-aligned — **같은 그림 세트 안에서만** 눈·입을 갈아끼운다
 *
 * 왜 이 방식인가 (실측으로 확정된 것):
 *   표정 컷아웃끼리는 이미 픽셀 단위로 정렬돼 있다(알파 bbox 1px 이내).
 *   따라서 확대·회전·보간이 전혀 필요 없고 **좌표 그대로 복사**하면 된다.
 *   서로 다른 그림(컷아웃 ↔ 장면)에서 떼어 붙이면 아무리 잘 맞춰도
 *   입 위치가 미세하게 흔들리고 볼터치·외곽선이 일그러진다. 하지 말 것.
 *
 *   또한 **표정 이미지를 통째로 교체하지 않는다.** 통째 교체는 외곽선 안티에일리어싱이
 *   프레임마다 달라서(실측 5,000~7,000px 산발 차이) 캐릭터 전체가 지글거린다.
 *   항상 하나의 베이스에서 출발해 마스크 안쪽만 덮어쓴다 → 마스크 밖은 바이트 단위로 동일.
 *
 * 마스크는 사각형이 아니라 **차이 성분(connected component)** 이다.
 *   사각형이면 경계가 다른 부위를 자른다(토리는 눈 상자와 입 상자가 겹친다).
 *   차이 성분 + ROI 중심 판정이면 눈만/입만 정확히 집힌다.
 *
 * 사용:
 *   node bin/13-graft-aligned.mjs --base 기본.png --out 결과.png \
 *        --graft 설명.png:540,640,870,800 --graft 경고.png:390,290,1030,620
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

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const grafts = a.map((v, i) => (a[i] === '--graft' ? a[i + 1] : null)).filter(Boolean);
const BASE = arg('base'), OUT = arg('out');
const TH = +(arg('th') || 40), GROW = +(arg('grow') || 4), MIN = +(arg('min') || 150), FEATHER = +(arg('feather') || 3);

const [W, H] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', BASE], { encoding: 'utf8' }).trim().split('x').map(Number);
const rd = f => Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', f,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: W * H * 4 + 8192 }));

const out = Buffer.from(rd(BASE));            // 베이스를 그대로 복사해 시작
const base = rd(BASE);

for (const g of grafts) {
  const m = g.match(/^(.*):(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/);
  if (!m) throw new Error(`--graft 형식: 파일:x0,y0,x1,y1  (받은 값: ${g})`);
  const [, file, X0, Y0, X1, Y1] = m;
  const [rx0, ry0, rx1, ry1] = [+X0, +Y0, +X1, +Y1];
  const don = rd(file);

  const dif = (i) => Math.max(
    Math.abs(base[i * 4] - don[i * 4]), Math.abs(base[i * 4 + 1] - don[i * 4 + 1]),
    Math.abs(base[i * 4 + 2] - don[i * 4 + 2]), Math.abs(base[i * 4 + 3] - don[i * 4 + 3]));

  // 1) 차이 성분 라벨링 → ROI 안에 중심이 있고 충분히 큰 덩어리만 채택
  const seen = new Uint8Array(W * H), mask = new Uint8Array(W * H);
  let taken = 0;
  for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
    const i = y * W + x;
    if (seen[i] || dif(i) <= TH) continue;
    const st = [i], px = []; seen[i] = 1;
    let x0 = x, x1 = x, y0 = y, y1 = y;
    while (st.length) {
      const p = st.pop(), qx = p % W, qy = (p - qx) / W; px.push(p);
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (seen[q] || dif(q) <= TH) continue;
        seen[q] = 1; st.push(q);
      }
    }
    if (px.length < MIN) continue;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (cx < rx0 || cx > rx1 || cy < ry0 || cy > ry1) continue;   // 중심이 ROI 밖이면 남의 부위
    for (const p of px) mask[p] = 255;
    taken += px.length;
  }

  // 2) 팽창 — 마스크 경계를 '두 그림이 같은' 영역까지 밀어낸다 (경계선이 안 보이게)
  for (let r = 0; r < GROW; r++) {
    const nx = Uint8Array.from(mask);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (mask[i]) continue;
      if (mask[i - 1] || mask[i + 1] || mask[i - W] || mask[i + W]) nx[i] = 255;
    }
    mask.set(nx);
  }

  // 3) 페더 — 박스 블러로 부드러운 알파. 이미 같은 영역이므로 번짐이 해롭지 않다.
  let soft = Float32Array.from(mask, v => v / 255);
  for (let r = 0; r < FEATHER; r++) {
    const nx = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      nx[i] = (soft[i] * 4 + soft[i - 1] + soft[i + 1] + soft[i - W] + soft[i + W]) / 8;
    }
    soft = nx;
  }

  for (let i = 0; i < W * H; i++) {
    const f = soft[i]; if (f <= 0.002) continue;
    const g2 = 1 - f, o = i * 4;
    out[o] = out[o] * g2 + don[o] * f;
    out[o + 1] = out[o + 1] * g2 + don[o + 1] * f;
    out[o + 2] = out[o + 2] * g2 + don[o + 2] * f;
    out[o + 3] = out[o + 3] * g2 + don[o + 3] * f;
  }
  console.log(`   ← ${file.split('/').pop()}  ROI(${rx0},${ry0})-(${rx1},${ry1})  채택 ${taken}px`);
}

execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', '1', OUT], { input: out });
console.log(`✓ ${OUT.split('/').pop()}`);
