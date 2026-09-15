#!/usr/bin/env node
/**
 * 10-repair-crown — ⚠️ **폐기됨. 쓰지 말 것.** (bin/16-rebuild-ears.mjs 를 쓴다)
 *
 * 장면 이미지에서 정수리를 떼어 컷아웃에 이어 붙이는 방식이다. 실패했다:
 * 장면 캐릭터와 컷아웃은 별개 생성물이라 머리 비율이 달라, 동공으로 정렬해도
 * 실루엣이 어긋나 이음매에서 **두 모양이 겹쳐 보인다.** 배경을 다각형으로 잘라내면
 * 귀 주변에 각진 배경 조각도 남는다. 기록용으로만 남긴다.
 *
 * 원래 설명:
 * 클로즈업 컷아웃이 머리 위에서 평평하게 잘려 있으면, 그 단면을 띠로 가리는 수밖에
 * 없어 화면이 답답해진다. 같은 캐릭터가 온전히 그려진 다른 그림(대화장면)에서
 * **머리 위 영역만** 떼어 이어 붙인다.
 *
 * ⚠️ 배경 제거를 자동으로 하려 하지 말 것.
 *    채도 판정 → 책장의 흰 바인더가 통과한다.
 *    어두운 외곽선 flood fill → 흐린 배경과 닿아 새어나간다.
 *    (둘 다 실측 실패) → **윤곽 다각형을 직접 지정**하는 것이 유일하게 확실하다.
 *    머리 위 실루엣은 한 번만 읽으면 되고, 격자를 얹어 좌표를 읽으면 5분이면 끝난다.
 *
 * 정렬은 동공 두 개: 간격 비 = 배율, 중점 = 기준점.
 *
 * 사용: node bin/10-repair-crown.mjs <컷아웃> <장면> <출력> \
 *         --cut-pupils x1,y1,x2,y2 --src-pupils x1,y1,x2,y2 \
 *         --poly "x,y x,y ..." (장면 좌표) --add 160 --blend 40
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
const files = [];
for (let i = 0; i < a.length; i++) {
  if (a[i].startsWith('--')) { i++; continue; }
  files.push(a[i]);
}
const [cutFile, srcFile, outFile] = files;
const ADD = +(arg('add') || 160);
const BLEND = +(arg('blend') || 40);
const POLY = arg('poly').trim().split(/\s+/).map(p => p.split(',').map(Number));

const dim = f => execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', f], { encoding: 'utf8' }).trim().split('x').map(Number);
const rgba = (f, w, h) => Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', f,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: w * h * 4 + 8192 }));

const [CW, CH] = dim(cutFile), [SW, SH] = dim(srcFile);
const cut = rgba(cutFile, CW, CH), src = rgba(srcFile, SW, SH);

const [cx1, cy1, cx2, cy2] = arg('cut-pupils').split(',').map(Number);
const [sx1, sy1, sx2, sy2] = arg('src-pupils').split(',').map(Number);
const S = Math.hypot(cx2 - cx1, cy2 - cy1) / Math.hypot(sx2 - sx1, sy2 - sy1);  // 장면→컷아웃
const CMX = (cx1 + cx2) / 2, CMY = (cy1 + cy2) / 2;
const SMX = (sx1 + sx2) / 2, SMY = (sy1 + sy2) / 2;

/** 다각형 내부 판정 (장면 좌표) */
function inPoly(px, py) {
  let inside = false;
  for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
    const [xi, yi] = POLY[i], [xj, yj] = POLY[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const NH = CH + ADD;
const out = Buffer.alloc(CW * NH * 4);

// 덧붙일 영역을 장면에서 가져오되, 다각형 안쪽만
for (let y = -ADD; y < BLEND; y++) {
  for (let x = 0; x < CW; x++) {
    const sxf = (x - CMX) / S + SMX, syf = (y - CMY) / S + SMY;
    const sx = Math.round(sxf), sy = Math.round(syf);
    if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) continue;
    if (!inPoly(sxf, syf)) continue;
    const so = (sy * SW + sx) * 4, to = ((y + ADD) * CW + x) * 4;
    out[to] = src[so]; out[to + 1] = src[so + 1]; out[to + 2] = src[so + 2]; out[to + 3] = 255;
  }
}

// 원래 컷아웃을 그대로 얹는다 (이음새는 세로 그라디언트)
for (let y = 0; y < CH; y++) {
  for (let x = 0; x < CW; x++) {
    const so = (y * CW + x) * 4, to = ((y + ADD) * CW + x) * 4;
    const al = cut[so + 3];
    if (al === 0) continue;
    const w = y < BLEND ? y / BLEND : 1;
    const f = (al / 255) * w, g = 1 - f;
    out[to] = out[to] * g + cut[so] * f;
    out[to + 1] = out[to + 1] * g + cut[so + 1] * f;
    out[to + 2] = out[to + 2] * g + cut[so + 2] * f;
    out[to + 3] = Math.max(out[to + 3], al);
  }
}

execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', `${CW}x${NH}`, '-i', 'pipe:0', '-frames:v', '1', outFile], { input: out });
console.log(`  ${cutFile.split('/').pop()} → ${outFile.split('/').pop()}  ${CW}x${CH} → ${CW}x${NH}`);
