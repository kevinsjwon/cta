#!/usr/bin/env node
/**
 * 06-find-watermark — Flyworks 워터마크(보라 로고 + 하단 텍스트) 위치 자동 검출
 *
 * Flyworks 무료 티어 워터마크는 렌더마다 위치가 바뀌고, 캐릭터 얼굴 위에 얹히기도 한다.
 * 크롭으로 못 지우는 경우가 있으므로 위치를 찾아 ffmpeg `delogo` 로 지워야 한다.
 *
 * 로고는 채도 높은 보라(파랑>빨강>초록)라 캐릭터·사무실 배경에는 없는 색이다.
 * 이 색을 스캔해 바운딩박스를 잡고, 로고 아래 텍스트까지 덮도록 세로로 확장한다.
 *
 * 사용: node bin/06-find-watermark.mjs <클립.mp4> [샘플초=3]
 * 출력: delogo 파라미터 (x:y:w:h)
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

const file = process.argv[2];
const at = process.argv[3] || '3';
if (!file) { console.error('사용: 06-find-watermark.mjs <클립.mp4> [샘플초]'); process.exit(1); }

const [W, H] = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' })
  .trim().split('x').map(Number);

const px = Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-ss', at, '-i', file,
  '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: W * H * 3 + 4096 }));

// 보라 로고: 파랑이 지배적이고 초록이 낮으며 채도가 높다
const hit = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3, r = px[o], g = px[o + 1], b = px[o + 2];
    if (b > 140 && b - g > 60 && b - r > 30 && r > 60) hit.push([x, y]);
  }
}
if (hit.length < 40) { console.log('NONE'); process.exit(0); }

// ⚠️ 전체 bbox 를 그대로 쓰면 안 된다. 배경(사무실 바인더 등)에 보라 계열이 섞여 있으면
// 프레임 전체가 잡힌다. 로고는 **작고 조밀한 덩어리**이므로 격자 밀도로 최빈 셀을 찾고
// 그 주변만 취한다.
const CELL = Math.max(16, Math.round(Math.min(W, H) / 40));
const grid = new Map();
for (const [x, y] of hit) {
  const k = `${(x / CELL) | 0},${(y / CELL) | 0}`;
  grid.set(k, (grid.get(k) || 0) + 1);
}
const [bk] = [...grid.entries()].sort((a, b) => b[1] - a[1])[0];
const [gx, gy] = bk.split(',').map(Number);
const cx = (gx + 0.5) * CELL, cy = (gy + 0.5) * CELL;
const R = CELL * 3;   // 최빈 셀 주변만 로고로 인정
let minX = W, minY = H, maxX = -1, maxY = -1, n = 0;
for (const [x, y] of hit) {
  if (Math.abs(x - cx) > R || Math.abs(y - cy) > R) continue;
  n++;
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
if (n < 40) { console.log('NONE'); process.exit(0); }

// 로고 아래 텍스트("飞影数字人")까지 덮도록 세로로 확장 + 여유
const lw = maxX - minX + 1, lh = maxY - minY + 1;
const padX = Math.round(lw * 0.9), padTop = Math.round(lh * 0.35), padBot = Math.round(lh * 1.5);
let x = Math.max(0, minX - padX), y = Math.max(0, minY - padTop);
let w = Math.min(W - x, lw + padX * 2), h = Math.min(H - y, lh + padTop + padBot);
// delogo 는 박스 바깥 1px 을 참조하므로 프레임 가장자리에 붙으면 안 된다
x = Math.max(1, x); y = Math.max(1, y);
w = Math.min(w, W - x - 1); h = Math.min(h, H - y - 1);

console.log(`${x}:${y}:${w}:${h}`);
console.error(`  ${file.split('/').pop()}  ${W}x${H}  로고픽셀 ${n}개  →  delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
