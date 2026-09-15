#!/usr/bin/env node
/**
 * 15-render-frames — 미리 만든 완성 프레임을 골라 재생한다
 *
 * 프레임은 14-compose-shot 이 만들어 둔 {화자}_{표정}_{입}.png (1080x1920) 뿐이다.
 * 렌더러는 **고르기만** 한다. 좌표 계산도, 합성도 하지 않는다.
 * → 화자 위치·크기가 프레임마다 달라질 물리적 여지가 없다.
 *
 * 표정 매핑: 대본의 표정 이름이 프레임에 없으면 대표 표정으로 접는다.
 *   너굴 '설명' 은 눈이 '기본' 과 같고 입만 열린 그림이므로 '기본' 으로 접는다.
 *   (입 열림은 발음에서 나온다. 표정으로 중복해서 열면 입이 두 겹으로 보인다.)
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build'), OUT = join(ROOT, 'output');
mkdirSync(OUT, { recursive: true });
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const DIR = resolve(ROOT, arg('dir'));
const NAME = arg('name');
const [OW, OH] = [1080, 1920], FPS = 24;

const tl = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const vis = JSON.parse(readFileSync(join(BUILD, 'visemes.json'), 'utf8'));

// 표정 → 프레임 매핑은 **24-build-chars 가 실측으로 만들어 둔 파일**에서 읽는다.
// 하드코딩하면 캐릭터가 바뀔 때마다 코드를 고쳐야 하고, 빠뜨리면 조용히 기본으로 접힌다.
const EXPR = JSON.parse(readFileSync(join(ROOT, 'input', 'exprmap.json'), 'utf8'));
const OPEN = { A: 1.0, E: 0.45, EO: 0.72, O: 0.82, U: 0.5, I: 0.25, M: 0.0, X: 0.08, R: 0.04 };
const OPEN_TH = +(process.env.OPEN_TH || 0.40);

const cache = {};
const frame = key => (cache[key] ??= Buffer.from(execFileSync(FFMPEG,
  ['-v', 'error', '-i', join(DIR, `${key}.png`), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: OW * OH * 3 + 8192 })));

const mouthAt = {};
for (const s of vis.speakers) {
  const arr = new Array(vis.totalFrames).fill('R');
  for (const r of s.mouth) for (let i = 0; i < r.n; i++) if (r.f + i < arr.length) arr[r.f + i] = r.s;
  mouthAt[s.id] = arr;
}
// 대사 사이 공백에서는 직전 대사의 화자·표정을 유지하고 입만 닫는다 (화면이 튀지 않게)
const lineAt = t => {
  let cur = tl.lines[0];
  for (const L of tl.lines) { if (t >= L.start - 0.15) cur = L; else break; }
  return cur;
};

const nFrames = Math.ceil(tl.total * FPS);
const assPath = join(BUILD, 'captions.ass').replace(/([:\\])/g, '\\$1');
const outFile = join(OUT, `${NAME}.mp4`);

// fontsdir: darwin 은 시스템 폰트 폴더를 명시(기존 동작 보존).
// linux/win 은 libass 가 fontconfig 로 이름 해석을 하므로 지정하지 않는다.
// (강제로 폴더를 주고 싶으면 FONTS_DIR 환경변수로 지정 가능.)
const fontsdir = process.env.FONTS_DIR
  ? `:fontsdir=${process.env.FONTS_DIR.replace(/([:\\])/g, '\\$1')}`
  : (process.platform === 'darwin' ? ':fontsdir=/System/Library/Fonts' : '');

const ff = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${OW}x${OH}`, '-framerate', String(FPS), '-i', 'pipe:0',
  '-i', join(BUILD, 'master.wav'),
  '-filter_complex', `[0:v]ass='${assPath}'${fontsdir},format=yuv420p[v]`,
  '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile],
  { stdio: ['pipe', 'inherit', 'inherit'] });

const stat = {};
for (let f = 0; f < nFrames; f++) {
  const t = f / FPS, L = lineAt(t);
  const spk = L.spk;
  const expr = EXPR[spk][L.bg] || '기본';
  const talking = t >= L.start && t <= L.end + 0.06;
  const v = mouthAt[spk]?.[Math.min(vis.totalFrames - 1, Math.floor(t * vis.fps))] || 'R';
  const mouth = talking && (OPEN[v] ?? 0) >= OPEN_TH ? 'open' : 'closed';
  const key = `${spk}_${expr}_${mouth}`;
  stat[key] = (stat[key] || 0) + 1;
  if (!ff.stdin.write(frame(key))) await new Promise(r => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));
console.log(`✅ ${outFile}`);
console.log(`   ${nFrames}프레임 / ${tl.total.toFixed(2)}s   ${Object.entries(stat).sort((x, y) => y[1] - x[1]).map(([k, v2]) => `${k}:${v2}`).join('  ')}`);
