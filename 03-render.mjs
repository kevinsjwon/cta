#!/usr/bin/env node
/**
 * 03-render — 입모양 타임라인 + 캐릭터/배경 레이어 → 최종 mp4
 *
 * 전부 평면 2D 로 구성한다. 원근·확대 전경·푸시인·명암 깊이 없음.
 * 색면과 실루엣만 쓴다.
 *
 * MODE=dialogue   두 캐릭터. 화자는 앞면(립싱크), 청자는 뒷면. 화자가 바뀌면
 *                 앞/뒤가 뒤집히고 배경도 바뀐다(같은 장소의 다른 벽면).
 *                 좌우 위치는 고정한다(180도 법칙).
 * MODE=narration  화자 1명이 한 자리에 고정. 배경만 대사 내용에 맞춰 전환한다.
 *                 배경은 script.tsv 5번째 열(bg)로 지정.
 *
 * 환경변수: MODE, ASPECT=9:16|16:9, NAME, NARRATOR(나레이션 화자 ID)
 */
import { Resvg } from '@resvg/resvg-js';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build'), OUT = join(ROOT, 'output');
mkdirSync(OUT, { recursive: true });

const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();

const MODE = process.env.MODE || 'dialogue';
const ASPECT = process.env.ASPECT || '9:16';
const FPS = 24;
const TAG = ASPECT === '16:9' ? 'wide' : 'tall';
const [RW, RH] = ASPECT === '16:9' ? [960, 540] : [540, 960];
const [OW, OH] = ASPECT === '16:9' ? [1920, 1080] : [1080, 1920];
const PRE_ROLL = 0.18;

const vis = JSON.parse(readFileSync(join(BUILD, 'visemes.json'), 'utf8'));
const tl = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const PLACE = JSON.parse(readFileSync(join(ROOT, 'input', 'placement.json'), 'utf8'));
const nFrames = Math.ceil(vis.total * FPS);

function expand(rl, n) {
  const a = new Array(n).fill('R');
  for (const r of rl) for (let i = 0; i < r.n; i++) if (r.f + i < n) a[r.f + i] = r.s;
  return a;
}
const px = RW * RH * 4;

// ── 래스터화 ────────────────────────────────────────────────────────
function rasterH(file, height) {
  const img = new Resvg(readFileSync(file, 'utf8'), { fitTo: { mode: 'height', value: Math.round(height) } }).render();
  return { data: Buffer.from(img.pixels), w: img.width, h: img.height };
}
/** 배경은 화면을 꽉 채워야 하므로 폭 기준 + 버퍼로 평탄화 */
function rasterBg(name) {
  const f = join(ROOT, 'input', 'backgrounds', `${name}.${TAG}.svg`);
  if (!existsSync(f)) throw new Error(`배경 없음: ${f}\n  → node bin/00b-build-backgrounds.mjs 실행`);
  const img = new Resvg(readFileSync(f, 'utf8'), { fitTo: { mode: 'width', value: RW } }).render();
  const src = Buffer.from(img.pixels);
  const b = Buffer.alloc(px);
  for (let y = 0; y < RH; y++) {
    const sy = Math.min(img.height - 1, y);
    src.copy(b, y * RW * 4, sy * img.width * 4, sy * img.width * 4 + RW * 4);
  }
  for (let i = 3; i < px; i += 4) b[i] = 255;
  return b;
}

function blit(dst, src, dx, dy) {
  const { data, w, h } = src;
  const x0 = Math.max(0, -dx), x1 = Math.min(w, RW - dx);
  const y0 = Math.max(0, -dy), y1 = Math.min(h, RH - dy);
  for (let y = y0; y < y1; y++) {
    let so = (y * w + x0) * 4, to = ((dy + y) * RW + dx + x0) * 4;
    for (let x = x0; x < x1; x++, so += 4, to += 4) {
      const a = data[so + 3];
      if (a === 0) continue;
      if (a === 255) { dst[to] = data[so]; dst[to + 1] = data[so + 1]; dst[to + 2] = data[so + 2]; }
      else {
        const f = a / 255, g = 1 - f;
        dst[to] = dst[to] * g + data[so] * f;
        dst[to + 1] = dst[to + 1] * g + data[so + 1] * f;
        dst[to + 2] = dst[to + 2] * g + data[so + 2] * f;
      }
      dst[to + 3] = 255;
    }
  }
}

// ── 캐릭터 로드 ─────────────────────────────────────────────────────
const MOUTH_KEYS = ['A', 'E', 'EO', 'O', 'U', 'I', 'M', 'X', 'R'];
function loadCharacter(id) {
  const dir = join(ROOT, 'input', 'characters', id);
  const geom = PLACE[id]?.[TAG];
  if (!geom) throw new Error(`placement.json 에 ${id}.${TAG} 없음`);
  const fh = geom.frontH * RH, bh = geom.backH * RH;
  return {
    id, geom,
    front: {
      body: rasterH(join(dir, 'front_body.svg'), fh),
      eyesOpen: rasterH(join(dir, 'front_eyes_open.svg'), fh),
      eyesClosed: rasterH(join(dir, 'front_eyes_closed.svg'), fh),
      mouth: Object.fromEntries(MOUTH_KEYS.map(m => [m, rasterH(join(dir, `front_mouth_${m}.svg`), fh)])),
    },
    back: rasterH(join(dir, 'back.svg'), bh),
  };
}
const chars = {};
for (const s of vis.speakers) chars[s.id] = { ...loadCharacter(s.id), ...s, mouthFrames: expand(s.mouth, vis.totalFrames) };

// ── 배경 준비 ───────────────────────────────────────────────────────
const bgCache = {};
const bgOf = name => (bgCache[name] ||= rasterBg(name));

let bgForLine;   // (line) => 배경 이름
if (MODE === 'narration') {
  const fallback = 'narr_intro';
  bgForLine = L => L?.bg || fallback;
  // 지정 안 된 줄은 직전 줄의 배경을 이어받는다
  let last = fallback;
  for (const L of tl.lines) { if (L.bg) last = L.bg; else L.bg = last; }
} else {
  bgForLine = L => (chars[L.spk]?.geom.side > 0 ? 'dialogue_A' : 'dialogue_B');
}
for (const L of tl.lines) bgOf(bgForLine(L));

// ── 숏 스케줄 ───────────────────────────────────────────────────────
function lineAt(t) {
  let cur = tl.lines[0];
  for (const L of tl.lines) { if (t >= L.start - PRE_ROLL) cur = L; else break; }
  return cur;
}

// ── ASS 자막 ────────────────────────────────────────────────────────
function ts(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`;
}
{
  const marginV = ASPECT === '16:9' ? 56 : 210;
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OW}
PlayResY: ${OH}
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Base,Apple SD Gothic Neo,${Math.round(OH * 0.032)},&H00FFFFFF,&H00201810,&H90000000,1,1,5,0,2,90,90,${marginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
  const ev = tl.lines.map(L =>
    `Dialogue: 0,${ts(L.start)},${ts(L.end + 0.2)},Base,${L.spk},0,0,0,,${L.text.replace(/\n/g, '\\N')}`).join('\n');
  writeFileSync(join(BUILD, 'captions.ass'), head + ev + '\n');
}

// ── 렌더 ────────────────────────────────────────────────────────────
const name = process.env.NAME || `${MODE}_${ASPECT.replace(':', 'x')}`;
const outFile = join(OUT, `${name}.mp4`);
const assPath = join(BUILD, 'captions.ass').replace(/([:\\])/g, '\\$1');

const ff = spawn(FFMPEG, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${RW}x${RH}`, '-framerate', String(FPS), '-i', 'pipe:0',
  '-i', join(BUILD, 'master.wav'),
  '-filter_complex', `[0:v]scale=${OW}:${OH}:flags=lanczos,ass='${assPath}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
  '-map', '[v]', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart',
  outFile,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const NARRATOR = process.env.NARRATOR || tl.lines[0].spk;
const shapeCount = {};
let written = 0, cuts = 0, prevKey = null;

const place = (layer, geom, kind) => [
  Math.round(RW * (0.5 + geom.side * geom[kind + 'X']) - layer.w / 2),
  Math.round(RH * geom[kind + 'Bottom'] - layer.h),
];

for (let f = 0; f < nFrames; f++) {
  const t = f / FPS;
  const L = lineAt(t);
  const speakerId = MODE === 'narration' ? NARRATOR : L.spk;

  const bgName = bgForLine(L);
  if (bgName !== prevKey) { cuts++; prevKey = bgName; }

  const buf = Buffer.allocUnsafe(px);
  bgOf(bgName).copy(buf);

  const S = chars[speakerId];
  // 청자(뒷면) 먼저 → 화자(앞면) 나중. 평면이라 겹침이 거의 없다.
  if (MODE === 'dialogue') {
    const B = Object.values(chars).find(c => c.id !== speakerId);
    if (B) blit(buf, B.back, ...place(B.back, B.geom, 'back'));
  }
  const fl = S.front;
  const [fx, fy] = place(fl.body, S.geom, 'front');
  blit(buf, fl.body, fx, fy);
  blit(buf, S.blinks.some(b => Math.abs(b - t) < 0.09) ? fl.eyesClosed : fl.eyesOpen, fx, fy);
  const key = S.mouthFrames[Math.min(vis.totalFrames - 1, Math.floor(t * vis.fps))] || 'R';
  blit(buf, fl.mouth[key] || fl.mouth.R, fx, fy);
  shapeCount[key] = (shapeCount[key] || 0) + 1;

  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  if (++written % 240 === 0) process.stderr.write(`  ${written}/${nFrames} 프레임\n`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))));

console.log(`\n✅ ${outFile}`);
console.log(`   ${MODE} / ${OW}x${OH} @ ${FPS}fps / ${nFrames}프레임 / ${vis.total.toFixed(2)}s`);
console.log(`   배경 전환 ${cuts}회`);
console.log(`   입모양 분포: ${Object.entries(shapeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`);
