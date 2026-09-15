#!/usr/bin/env node
/**
 * 04c-dechecker — "투명 체커보드가 픽셀로 구워진" PNG → 진짜 알파 PNG
 *
 * 외부에서 받은 컷아웃 이미지가 rgba 인데 알파가 전부 255 이고, 배경 자리에
 * 회색/흰색 체커 무늬가 그대로 찍혀 있는 경우가 있다. 이때 단순 색상 키잉을 하면
 * 흰색 캐릭터(예: 흰 토끼)의 몸통까지 뚫린다.
 *
 * 그래서 **테두리에서 시작하는 flood fill** 로, 바깥과 연결된 체커 픽셀만 지운다.
 * 캐릭터 내부의 흰색은 외곽선에 막혀 채워지지 않으므로 안전하다.
 *
 * 사용: node bin/04c-dechecker.mjs <입력.png> <출력.png> [허용오차=14]
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');

const [inp, outp, tolArg] = process.argv.slice(2);
if (!inp || !outp) { console.error('사용: 04c-dechecker.mjs <입력.png> <출력.png> [허용오차]'); process.exit(1); }
if (!existsSync(inp)) { console.error(`입력 없음: ${inp}`); process.exit(1); }
const TOL = +(tolArg || 14);

const [W, H] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', inp], { encoding: 'utf8' }).trim().split('x').map(Number);

const px = Buffer.from(execFileSync(FFMPEG,
  ['-v', 'error', '-i', inp, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { maxBuffer: W * H * 4 + 1024 }));

// 체커 색 두 종을 테두리에서 자동 추출 (밝은 칸 / 어두운 칸)
const samples = [];
for (let x = 0; x < W; x += Math.max(1, Math.floor(W / 200))) {
  for (const y of [0, H - 1]) { const o = (y * W + x) * 4; samples.push([px[o], px[o + 1], px[o + 2]]); }
}
for (let y = 0; y < H; y += Math.max(1, Math.floor(H / 200))) {
  for (const x of [0, W - 1]) { const o = (y * W + x) * 4; samples.push([px[o], px[o + 1], px[o + 2]]); }
}
const lum = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
samples.sort((a, b) => lum(a) - lum(b));
const dark = samples[Math.floor(samples.length * 0.15)];
const light = samples[Math.floor(samples.length * 0.85)];
const isChecker = (r, g, b) =>
  (Math.abs(r - dark[0]) <= TOL && Math.abs(g - dark[1]) <= TOL && Math.abs(b - dark[2]) <= TOL) ||
  (Math.abs(r - light[0]) <= TOL && Math.abs(g - light[1]) <= TOL && Math.abs(b - light[2]) <= TOL);

// 체커 두 색 사이의 혼합색 판정 (확산 전용, 느슨함)
const dLum = lum(dark), lLum = lum(light);
const isCheckerBlend = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn > 22) return false;                    // 채도가 있으면 캐릭터
  const L = 0.299 * r + 0.587 * g + 0.114 * b;
  return L >= dLum - 26 && L <= lLum + 8;
};

// ⚠️ 색만으로는 판별할 수 없다.
// 흰 캐릭터(예: 흰 토끼)의 몸통 색은 밝은 체커 칸과 거의 같고, 몸통이 이미지
// 테두리에 닿아 있으면 "테두리 연결" 규칙으로도 통째로 지워진다.
//
// 그래서 **구조**로 판별한다: 체커보드는 두 색이 규칙적으로 번갈아 나오는 무늬다.
// 어떤 픽셀 주변 창(window)에 밝은 칸과 어두운 칸이 **둘 다** 충분히 있으면 체커,
// 한 색만 있으면 캐릭터의 단색 면이다. 적분영상으로 O(1) 조회한다.
const near = (r, g, b, ref) =>
  Math.abs(r - ref[0]) <= TOL && Math.abs(g - ref[1]) <= TOL && Math.abs(b - ref[2]) <= TOL;

const WIN = 12;                                  // 창 반지름 (체커 칸보다 커야 한다)
const iD = new Int32Array((W + 1) * (H + 1));
const iL = new Int32Array((W + 1) * (H + 1));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const d = near(px[o], px[o + 1], px[o + 2], dark) ? 1 : 0;
    const l = near(px[o], px[o + 1], px[o + 2], light) ? 1 : 0;
    const k = (y + 1) * (W + 1) + (x + 1);
    iD[k] = d + iD[k - 1] + iD[k - (W + 1)] - iD[k - (W + 1) - 1];
    iL[k] = l + iL[k - 1] + iL[k - (W + 1)] - iL[k - (W + 1) - 1];
  }
}
const boxSum = (I, x0, y0, x1, y1) =>
  I[(y1 + 1) * (W + 1) + (x1 + 1)] - I[y0 * (W + 1) + (x1 + 1)]
  - I[(y1 + 1) * (W + 1) + x0] + I[y0 * (W + 1) + x0];

const isPattern = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  const y0 = Math.max(0, y - WIN), y1 = Math.min(H - 1, y + WIN);
  for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    if (!isChecker(px[o], px[o + 1], px[o + 2])) continue;
    const x0 = Math.max(0, x - WIN), x1 = Math.min(W - 1, x + WIN);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const nd = boxSum(iD, x0, y0, x1, y1), nl = boxSum(iL, x0, y0, x1, y1);
    // 두 색이 모두 창의 12% 이상 → 체커 무늬
    if (nd >= area * 0.12 && nl >= area * 0.12) isPattern[i] = 1;
  }
}

// 무늬 픽셀을 씨앗으로 **제한된 거리만** 확산한다.
//
// ⚠️ 무제한 flood fill 을 쓰면 안 된다. 캐릭터 외곽선에 1픽셀이라도 틈이 있으면
// 그 틈으로 새어 들어가 흰 몸통 전체를 지워버린다(흰 토끼 뒤통수에서 실측).
// 체커 영역의 안티에일리어싱 가장자리만 흡수하면 충분하므로 반경을 제한한다.
const GROW = +(process.env.DECHECK_GROW || 8);
const bg = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) if (isPattern[i]) bg[i] = 1;
for (let r = 0; r < GROW; r++) {
  const add = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (bg[i]) continue;
      const o = i * 4;
      if (!isChecker(px[o], px[o + 1], px[o + 2])) continue;
      if ((x > 0 && bg[i - 1]) || (x < W - 1 && bg[i + 1]) ||
          (y > 0 && bg[i - W]) || (y < H - 1 && bg[i + W])) add.push(i);
    }
  }
  if (!add.length) break;
  for (const i of add) bg[i] = 1;
}

// 확산 패스: 이미 지워진 픽셀에 인접한 체커색 픽셀을 반복해서 흡수한다.
// 안티에일리어싱으로 잘게 쪼개진 체커 조각(요소 판정을 통과 못한 것)을 정리한다.
// ⚠️ 캐릭터에 넓은 흰색/무채색 면이 있으면(예: 흰 토끼) 확산이 외곽선을 넘어
// 몸통을 먹어버린다. 그런 캐릭터는 --nodilate 로 끈다.
if (!process.argv.includes('--nodilate')) {
  let changed = true, rounds = 0;
  while (changed && rounds++ < 40) {
    changed = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (bg[i]) continue;
        const o = i * 4;
        // 확산은 느슨한 기준을 쓴다: 체커 두 색 사이의 안티에일리어싱 혼합색은
        // 무채색이고 명도가 두 색 사이에 있다. 캐릭터의 흰 면도 여기 걸리지만
        // 두꺼운 외곽선이 확산을 막아 안쪽까지 번지지 않는다.
        if (!isChecker(px[o], px[o + 1], px[o + 2]) && !isCheckerBlend(px[o], px[o + 1], px[o + 2])) continue;
        if ((x > 0 && bg[i - 1]) || (x < W - 1 && bg[i + 1]) ||
            (y > 0 && bg[i - W]) || (y < H - 1 && bg[i + W])) { bg[i] = 1; changed = true; }
      }
    }
  }
}

// --clearwhite: 체커 제거 후에도 남는 "테두리와 연결된 near-white 잔여물"을 지운다.
// 체커의 밝은 칸이 안티에일리어싱으로 흰색에 가깝게 뭉개진 부분이 캐릭터 바운딩박스
// 둘레에 흰 액자처럼 남는 경우가 있다. 순백 영역이 없는 캐릭터(예: 갈색 너구리)에만 쓸 것.
if (process.argv.includes('--clearwhite')) {
  const WHITE = 232;
  const isW = i => { const o = i * 4; return px[o] >= WHITE && px[o + 1] >= WHITE && px[o + 2] >= WHITE; };
  const qw = new Int32Array(W * H);
  let hw = 0, tw = 0;
  const sw = i => { if (!bg[i] && isW(i)) { bg[i] = 1; qw[tw++] = i; } };
  for (let x = 0; x < W; x++) { sw(x); sw((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { sw(y * W); sw(y * W + W - 1); }
  // 이미 제거된 배경에 접한 흰 픽셀도 씨앗으로
  for (let i = 0; i < W * H; i++) if (bg[i]) { const x = i % W, y = (i / W) | 0;
    if (x > 0) sw(i - 1); if (x < W - 1) sw(i + 1); if (y > 0) sw(i - W); if (y < H - 1) sw(i + W); }
  while (hw < tw) {
    const i = qw[hw++], x = i % W, y = (i / W) | 0;
    if (x > 0) sw(i - 1); if (x < W - 1) sw(i + 1);
    if (y > 0) sw(i - W); if (y < H - 1) sw(i + W);
  }
  console.log(`     흰 잔여물 제거 ${tw}px`);
}

// 구멍 메우기: 이미지 테두리와 연결되지 않은 "배경" 영역은 캐릭터 내부의 오검출이다.
// (흰 몸통이 밝은 체커색과 같아 패턴으로 오판되는 경우를 되살린다)
// 캐릭터가 프레임을 꽉 채워 체커가 테두리에 안 닿는 이미지는 --noholefill 로 끈다.
if (!process.argv.includes('--noholefill')) {
  const reach = new Uint8Array(W * H);
  const q2 = new Int32Array(W * H);
  let h2 = 0, t2 = 0;
  const seed = i => { if (bg[i] && !reach[i]) { reach[i] = 1; q2[t2++] = i; } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (h2 < t2) {
    const i = q2[h2++], x = i % W, y = (i / W) | 0;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (y > 0) seed(i - W);
    if (y < H - 1) seed(i + W);
  }
  let restored = 0;
  for (let i = 0; i < W * H; i++) if (bg[i] && !reach[i]) { bg[i] = 0; restored++; }
  if (restored) console.log(`     구멍 복원 ${(restored / (W * H) * 100).toFixed(1)}%`);
}

// 알파 적용 + 경계 1px 페더 (안티에일리어싱 잔털 제거)
let cleared = 0;
for (let i = 0; i < W * H; i++) if (bg[i]) { px[i * 4 + 3] = 0; cleared++; }
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (bg[i] || px[i * 4 + 3] === 0) continue;
    let n = 0;
    if (bg[i - 1]) n++; if (bg[i + 1]) n++; if (bg[i - W]) n++; if (bg[i + W]) n++;
    if (n >= 2) px[i * 4 + 3] = 96;
    else if (n === 1) px[i * 4 + 3] = 190;
  }
}

execFileSync(FFMPEG, ['-y', '-nostdin', '-v', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', 'pipe:0',
  '-frames:v', '1', outp], { input: px });

console.log(`  ${inp.split('/').pop()} → ${outp.split('/').pop()}  ` +
  `${W}x${H} / 배경 ${(cleared / (W * H) * 100).toFixed(1)}% 제거 ` +
  `(체커색 rgb(${dark}) rgb(${light}))`);
