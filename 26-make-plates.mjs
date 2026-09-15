#!/usr/bin/env node
/**
 * 26-make-plates — 장면 이미지 → **배경·책상 판 3장**
 *
 *   build/cu/plate/shelf.png       배경(책장). 상하 미러 타일링으로 늘린다
 *   build/cu/plate/desk_top.png    책상 윗면(수평). 먼쪽이 어둡다
 *   build/cu/plate/desk_front.png  책상 앞판(수직). 더 어둡고 윗모서리가 빛을 받는다
 *
 * ⚠️ 책상을 한 장으로 깔면 화면 아래 40%가 균일한 나무판이라 **벽처럼 보인다**(§8.6).
 *    두 장으로 나눠야 모서리 선 하나로 원근이 생기고, 뒤통수 캐릭터가 앞판을 가려
 *    "칸막이 앞에 서 있는" 그림이 된다.
 *
 * ⚠️ 두 사각형(깨끗한 책장 띠 / 깨끗한 책상면)은 **장면마다 한 번 사람이 읽는다.**
 *    자동 검출은 캐릭터 마스크가 없으면 신뢰할 수 없다. `--grid` 로 좌표를 읽는다:
 *      node bin/26-make-plates.mjs --scene <img> --grid
 *    책장 띠 = 캐릭터 머리 위의 전 폭 구간 / 책상면 = 소품·캐릭터를 피한 좁은 구간
 *
 * ⚠️ `geq` 에는 반드시 `a='alpha(X,Y)'` 를 준다. 안 주면 알파가 0 이 되는데
 *    `overlay` 기본 format=yuv420 이 알파를 버려 **버그가 조용히 숨는다**(§8.6).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FF = (() => { try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {} return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'); })();
const FP = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');
const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const has = k => a.includes(`--${k}`);
const OUT = arg('out') || 'build/cu/plate';
const OW = 1080;

let scene = arg('scene');
if (!scene) {
  const c = existsSync('input/cast.json') && JSON.parse(readFileSync('input/cast.json', 'utf8'));
  scene = c && c.scenes && c.scenes[0];
}
if (!scene || !existsSync(scene)) { console.error('사용: node bin/26-make-plates.mjs --scene <장면.png> [--grid]'); process.exit(1); }
const [SW, SH] = execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', scene], { encoding: 'utf8' }).trim().split('x').map(Number);

if (has('grid')) {
  mkdirSync('build/verify', { recursive: true });
  const g = 'build/verify/plate_grid.png';
  execFileSync(FF, ['-y', '-v', 'error', '-i', scene, '-vf',
    `drawgrid=w=${Math.round(SW / 12)}:h=${Math.round(SW / 12)}:t=1:c=red@0.7,scale=900:-1`, '-frames:v', '1', g]);
  console.log(`✓ ${g}   (격자 ${Math.round(SW / 12)}px, 원본 ${SW}x${SH})`);
  console.log('  책장 띠  : 캐릭터 머리 **위**, 전 폭이 깨끗한 구간  → --shelf x,y,w,h');
  console.log('  책상면   : 소품·캐릭터를 피한 좁은 구간            → --desk  x,y,w,h');
  process.exit(0);
}

// 사각형은 **cast.json 에 남긴다.** 사람이 한 번 읽은 값이므로 파일에 없으면 재현이 끊긴다.
const castPath = 'input/cast.json';
const cast = existsSync(castPath) ? JSON.parse(readFileSync(castPath, 'utf8')) : null;
const saved = cast?.plates || {};
const rect = (k, def) => (arg(k) || (saved[k] && saved[k].join(',')) || def).split(',').map(Number);
// 기본값: 장면 비율에 대한 경험적 추정. 반드시 --grid 로 확인할 것.
const [sx, sy, sw, sh] = rect('shelf', `0,0,${SW},${Math.round(SH * 0.25)}`);
const [dx, dy, dw, dh] = rect('desk', `${Math.round(SW * 0.24)},${Math.round(SH * 0.88)},${Math.round(SW * 0.27)},${Math.round(SH * 0.12)}`);
mkdirSync(OUT, { recursive: true });

// ── 배경: 깨끗한 띠를 상하 미러 타일링. 세로로 그냥 늘리면 바인더가 막대처럼 뭉개진다.
execFileSync(FF, ['-y', '-v', 'error', '-i', scene, '-vf', `crop=${sw}:${sh}:${sx}:${sy}`, '-frames:v', '1', join(OUT, '_band.png')]);
execFileSync(FF, ['-y', '-v', 'error', '-i', join(OUT, '_band.png'), '-i', join(OUT, '_band.png'),
  '-filter_complex', '[0:v]split=2[a][b];[b]vflip[bf];[1:v]split=2[c][d];[d]vflip[df];' +
  `[a][bf][c][df]vstack=4,scale=${OW}:-1,gblur=sigma=3`, '-frames:v', '1', join(OUT, 'shelf.png')]);

// ── 책상 원본: 나뭇결이 가로선이라 **가로 확대는 5배까지도 티가 안 난다**
execFileSync(FF, ['-y', '-v', 'error', '-i', scene, '-vf', `crop=${dw}:${dh}:${dx}:${dy},scale=${OW}:${Math.round(dh * OW / dw)}`, '-frames:v', '1', join(OUT, 'desk_src.png')]);
const [, DSH] = execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', join(OUT, 'desk_src.png')], { encoding: 'utf8' }).trim().split('x').map(Number);
const CRISP = 60;                    // 위쪽 모서리는 원본 배율로 둔다 (늘리면 선이 두꺼워진다)

execFileSync(FF, ['-y', '-v', 'error', '-i', join(OUT, 'desk_src.png'), '-filter_complex',
  `[0:v]split=2[a][b];[a]crop=${OW}:${CRISP}:0:0[t];[b]crop=${OW}:${DSH - CRISP}:0:${CRISP},scale=${OW}:440[m];[t][m]vstack=2,` +
  `geq=r='r(X,Y)*(0.64+0.36*min(1,Y/300))':g='g(X,Y)*(0.64+0.36*min(1,Y/300))':b='b(X,Y)*(0.64+0.36*min(1,Y/300))':a='alpha(X,Y)',` +
  `drawbox=x=0:y=0:w=${OW}:h=6:color=0xC79A6A@0.85:t=fill,drawbox=x=0:y=6:w=${OW}:h=10:color=0x3a2412@0.35:t=fill`,
  '-frames:v', '1', join(OUT, 'desk_top.png')]);

execFileSync(FF, ['-y', '-v', 'error', '-i', join(OUT, 'desk_src.png'), '-filter_complex',
  `[0:v]crop=${OW}:${Math.min(DSH, 500)}:0:${Math.max(0, DSH - Math.min(DSH, 500))},scale=${OW}:470,` +
  `geq=r='r(X,Y)*(0.50-0.10*min(1,Y/430))':g='g(X,Y)*(0.50-0.10*min(1,Y/430))':b='b(X,Y)*(0.50-0.10*min(1,Y/430))':a='alpha(X,Y)',` +
  `drawbox=x=0:y=0:w=${OW}:h=5:color=0xE8C08A@0.9:t=fill,drawbox=x=0:y=5:w=${OW}:h=7:color=0x8a5a30@0.55:t=fill`,
  '-frames:v', '1', join(OUT, 'desk_front.png')]);

for (const f of ['shelf.png', 'desk_top.png', 'desk_front.png']) {
  const px = execFileSync(FF, ['-v', 'error', '-i', join(OUT, f), '-vf', 'format=rgba,crop=1:1:540:100', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const ok = px[3] === 255;
  console.log(`  ${f}  ${execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', join(OUT, f)], { encoding: 'utf8' }).trim()}  알파 ${ok ? 'OK' : '✗ 0 — geq 에 a 식이 빠졌다'}`);
}
if (cast) {                                   // 다음에 그대로 재현되도록 저장
  cast.plates = { shelf: [sx, sy, sw, sh], desk: [dx, dy, dw, dh] };
  writeFileSync(castPath, JSON.stringify(cast, null, 2) + '\n');
}
console.log(`✓ ${OUT}   책장 [${sx},${sy},${sw},${sh}]  책상 [${dx},${dy},${dw},${dh}]  → cast.json 에 저장`);
