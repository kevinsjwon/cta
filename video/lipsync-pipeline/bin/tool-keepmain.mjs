#!/usr/bin/env node
/**
 * tool-keepmain — 알파의 **주 덩어리만 남기고 고립된 잔재를 지운다**
 *
 * 체커 제거(04c) 후에는 모서리에 작은 섬이 남는 일이 있다(실측: 뒤통수 좌상단 210px).
 * 그대로 두면 알파 bbox 가 통째로 틀어져 배치 계산이 전부 어긋난다
 * (실측: bbox 가 x195 → x0 으로 잡혀 캐릭터 폭이 1019 → 1214 로 오판).
 *
 * 가장 큰 덩어리 대비 `--min`(기본 2%) 미만인 덩어리를 제거한다.
 *
 * 사용: node bin/tool-keepmain.mjs <입력.png> <출력.png> [--min 0.02]
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
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? +a[i + 1] : undefined; };
const files = a.filter((v, i) => !v.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
const [IN, OUT] = files;
const MIN = arg('min') ?? 0.02;

const [W, H] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', IN], { encoding: 'utf8' }).trim().split('x').map(Number);
const buf = Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', IN,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: W * H * 4 + 8192 }));

const lab = new Int32Array(W * H).fill(-1);
const sizes = [];
for (let i = 0; i < W * H; i++) {
  if (lab[i] >= 0 || buf[i * 4 + 3] <= 32) continue;
  const id = sizes.length; const st = [i]; lab[i] = id; let n = 0;
  while (st.length) {
    const p = st.pop(); n++;
    const x = p % W, y = (p - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (lab[q] >= 0 || buf[q * 4 + 3] <= 32) continue;
      lab[q] = id; st.push(q);
    }
  }
  sizes.push(n);
}
const max = Math.max(...sizes, 1);
let removed = 0, kept = 0;
for (let i = 0; i < W * H; i++) {
  const id = lab[i];
  if (id < 0) continue;
  if (sizes[id] / max < MIN) { buf[i * 4 + 3] = 0; removed++; } else kept++;
}
execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', '1', OUT], { input: buf });
console.log(`  ${IN.split('/').pop()} → 덩어리 ${sizes.length}개 중 ${removed ? `${removed}px 제거` : '제거 없음'}`);
