#!/usr/bin/env node
/**
 * 08-align-expressions — 표정 컷아웃들을 공통 bbox 로 정렬
 *
 * 같은 캐릭터의 표정 이미지라도 알파 bbox 가 몇 px 씩 어긋나 있으면,
 * 표정을 바꿀 때 캐릭터가 **미세하게 움직이는 것처럼** 보인다.
 * 첫 번째(기준) 이미지의 bbox 에 맞춰 나머지를 평행이동한다.
 *
 * 사용: node bin/08-align-expressions.mjs <출력폴더> <기준.png> <대상1.png> [대상2.png ...]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');

const [outDir, ...files] = process.argv.slice(2);
if (!outDir || files.length < 2) {
  console.error('사용: 08-align-expressions.mjs <출력폴더> <기준.png> <대상...>'); process.exit(1);
}
mkdirSync(outDir, { recursive: true });

function load(f) {
  const [w, h] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', f], { encoding: 'utf8' }).trim().split('x').map(Number);
  const px = execFileSync(FFMPEG, ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: w * h * 4 + 4096 });
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 40) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { w, h, px, box: [x0, y0, x1, y1] };
}

const ref = load(files[0]);
// 모든 출력은 기준 이미지 크기로 통일한다 (크기가 다르면 배치 시 배율이 달라진다)
const W = ref.w, H = ref.h;
console.log(`  기준 ${basename(files[0])}  ${W}x${H}  bbox ${ref.box.join(',')}`);

for (const f of files) {
  const im = load(f);
  const dx = Math.round((ref.box[0] + ref.box[2]) / 2 - (im.box[0] + im.box[2]) / 2);
  const dy = Math.round((ref.box[1] + ref.box[3]) / 2 - (im.box[1] + im.box[3]) / 2);
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < im.h; y++) {
    const ty = y + dy; if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < im.w; x++) {
      const tx = x + dx; if (tx < 0 || tx >= W) continue;
      const so = (y * im.w + x) * 4, to = (ty * W + tx) * 4;
      out[to] = im.px[so]; out[to + 1] = im.px[so + 1];
      out[to + 2] = im.px[so + 2]; out[to + 3] = im.px[so + 3];
    }
  }
  const dst = join(outDir, basename(f));
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', '1', dst], { input: out });
  console.log(`  ${basename(f).padEnd(24)} 이동 (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})`);
}
