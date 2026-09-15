#!/usr/bin/env node
/**
 * 12-render-scene — 장면 변형 프레임을 골라 재생하는 렌더러
 *
 * 11-build-variants 가 만든 (화자 × 표정 × 입열림) 조합 중 하나를 매 프레임 고른다.
 * 베이스가 완성된 장면 이미지이므로 배경·책상·구도·잘림 문제가 애초에 없다.
 * 캐릭터는 픽셀 단위로 고정이고 바뀌는 것은 입과 눈뿐이다.
 *
 * 환경변수: MODE=dialogue|closeup
 *   dialogue — 장면 전체 (오버더숄더 구도가 원본에 들어 있다)
 *   closeup  — 화자 얼굴로 확대 (config 의 zoom/center 사용)
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

const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const MODE = process.env.MODE || 'dialogue';
const [OW, OH] = [1080, 1920];
const FPS = 24;

const tl = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const vis = JSON.parse(readFileSync(join(BUILD, 'visemes.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(resolve(arg('config')), 'utf8'));
const nFrames = Math.ceil(tl.total * FPS);

// 발음 세기 → 열림/닫힘 (중간값 없음: 겹쳐 보이면 안 된다)
const OPEN = { A: 1.0, E: 0.45, EO: 0.72, O: 0.82, U: 0.5, I: 0.25, M: 0.0, X: 0.08, R: 0.04 };
const OPEN_TH = +(process.env.OPEN_TH || 0.40);

/** 변형 이미지를 출력 크기로 미리 래스터화 */
function load(file, zoom) {
  const vf = zoom
    ? `scale=${Math.round(OW * zoom.scale)}:-1:flags=lanczos,` +
      `crop=${OW}:${OH}:${Math.round(zoom.x)}:${Math.round(zoom.y)}`
    : `scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH}`;
  return Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', vf,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: OW * OH * 3 + 8192 }));
}

const frames = {};
for (const [id, c] of Object.entries(cfg.characters)) {
  const zoom = MODE === 'closeup' ? c.zoom : null;
  for (const e of c.exprs) for (const m of ['closed', 'open']) {
    const key = `${id}_${e}_${m}`;
    frames[key] = load(join(ROOT, 'build', 'cu', 'variants', `${key}.png`), zoom);
  }
  console.log(`  ${id}: 표정 ${c.exprs.join('/')} × 입 2 = ${c.exprs.length * 2}장`);
}

const mouthFrames = {};
for (const s of vis.speakers) {
  const a = new Array(vis.totalFrames).fill('R');
  for (const r of s.mouth) for (let i = 0; i < r.n; i++) if (r.f + i < a.length) a[r.f + i] = r.s;
  mouthFrames[s.id] = a;
}
const lineAt = t => {
  let cur = tl.lines[0];
  for (const L of tl.lines) { if (t >= L.start - 0.15) cur = L; else break; }
  return cur;
};

const name = arg('name') || `scene_${MODE}`;
const outFile = join(OUT, `${name}.mp4`);
const assPath = join(BUILD, 'captions.ass').replace(/([:\\])/g, '\\$1');

const ff = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${OW}x${OH}`, '-framerate', String(FPS), '-i', 'pipe:0',
  '-i', join(BUILD, 'master.wav'),
  '-filter_complex', `[0:v]ass='${assPath}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
  '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile],
  { stdio: ['pipe', 'inherit', 'inherit'] });

const stat = {};
for (let f = 0; f < nFrames; f++) {
  const t = f / FPS;
  const L = lineAt(t);
  const spk = MODE === 'closeup' ? L.spk : L.spk;
  const C = cfg.characters[spk];
  const expr = C.exprs.includes(L.bg) ? L.bg : '기본';
  const key = mouthFrames[spk]?.[Math.min(vis.totalFrames - 1, Math.floor(t * vis.fps))] || 'R';
  const mouth = (OPEN[key] ?? 0) >= OPEN_TH ? 'open' : 'closed';
  const id = `${spk}_${expr}_${mouth}`;
  stat[id] = (stat[id] || 0) + 1;
  if (!ff.stdin.write(frames[id])) await new Promise(r => ff.stdin.once('drain', r));
  if ((f + 1) % 300 === 0) process.stderr.write(`  ${f + 1}/${nFrames}\n`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));

console.log(`\n✅ ${outFile}`);
console.log(`   ${OW}x${OH} @ ${FPS}fps / ${nFrames}프레임 / ${tl.total.toFixed(2)}s`);
console.log(`   ${Object.entries(stat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
