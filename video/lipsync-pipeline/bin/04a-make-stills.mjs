#!/usr/bin/env node
/**
 * 04a-make-stills — 생성형 립싱크 모델에 넣을 입력 스틸 생성
 *
 * 두 전략:
 *  (A) 완성 프레임  대화 포맷은 "P가 말하는 장면" / "R이 말하는 장면" 두 가지뿐이다.
 *                   배경+두 캐릭터가 다 들어간 완성 프레임을 그대로 립싱크시키면
 *                   키잉이 필요 없고 결과가 깨끗하다. 호출 2회로 끝난다.
 *  (B) 그린스크린   나레이션은 배경이 7번 바뀐다. 캐릭터만 단색 위에 올려 립싱크한 뒤
 *                   크로마키로 뽑아 배경을 갈아끼운다. 호출 1회.
 *
 * 립싱크 모델 요구사항에 맞춘다: 정면, 얼굴이 충분히 크게, 입 닫힘, 단일 얼굴.
 * → 뒷면 캐릭터는 얼굴이 없으므로 모델이 앞면 얼굴만 잡는다.
 */
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build', 'stills');
mkdirSync(OUT, { recursive: true });

const TAG = process.env.ASPECT === '16:9' ? 'wide' : 'tall';
const [W, H] = TAG === 'wide' ? [1280, 720] : [768, 1280];   // 모델 친화적 해상도
const PLACE = JSON.parse(readFileSync(join(ROOT, 'input', 'placement.json'), 'utf8'));
const GREEN = '#00B140';

const px = W * H * 4;
function rasterH(file, height) {
  const img = new Resvg(readFileSync(file, 'utf8'), { fitTo: { mode: 'height', value: Math.round(height) } }).render();
  return { data: Buffer.from(img.pixels), w: img.width, h: img.height };
}
function blit(dst, src, dx, dy) {
  const { data, w, h } = src;
  for (let y = Math.max(0, -dy); y < Math.min(h, H - dy); y++) {
    let so = (y * w) * 4, to = ((dy + y) * W + dx) * 4;
    for (let x = 0; x < w; x++, so += 4, to += 4) {
      const tx = dx + x; if (tx < 0 || tx >= W) continue;
      const a = data[so + 3]; if (a === 0) continue;
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
function fill(buf, hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  for (let i = 0; i < px; i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; }
}
function bgBuf(name) {
  const img = new Resvg(readFileSync(join(ROOT, 'input', 'backgrounds', `${name}.${TAG}.svg`), 'utf8'),
    { fitTo: { mode: 'width', value: W } }).render();
  const src = Buffer.from(img.pixels), b = Buffer.alloc(px);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1, y);
    src.copy(b, y * W * 4, sy * img.width * 4, sy * img.width * 4 + W * 4);
  }
  for (let i = 3; i < px; i += 4) b[i] = 255;
  return b;
}
const charDir = id => join(ROOT, 'input', 'characters', id);
const place = (layer, geom, kind) => [
  Math.round(W * (0.5 + geom.side * geom[kind + 'X']) - layer.w / 2),
  Math.round(H * geom[kind + 'Bottom'] - layer.h),
];
function toPng(buf) {
  // resvg 는 SVG만 받으므로 raw RGBA → PNG 는 ffmpeg 로 처리한다
  return buf;
}

// ── (A) 대화용 완성 프레임 2장 ──────────────────────────────────────
// 립싱크 모델이 "닫힌 입"에서 시작하도록 mouth_R(쉼) 을 넣는다.
for (const speaker of ['P', 'R']) {
  const listener = speaker === 'P' ? 'R' : 'P';
  const gs = PLACE[speaker][TAG], gl = PLACE[listener][TAG];
  const buf = Buffer.from(bgBuf(gs.side > 0 ? 'dialogue_A' : 'dialogue_B'));

  const back = rasterH(join(charDir(listener), 'back.svg'), gl.backH * H);
  blit(buf, back, ...place(back, gl, 'back'));

  const fh = gs.frontH * H;
  const body = rasterH(join(charDir(speaker), 'front_body.svg'), fh);
  const [fx, fy] = place(body, gs, 'front');
  blit(buf, body, fx, fy);
  blit(buf, rasterH(join(charDir(speaker), 'front_eyes_open.svg'), fh), fx, fy);
  blit(buf, rasterH(join(charDir(speaker), 'front_mouth_R.svg'), fh), fx, fy);
  writeFileSync(join(OUT, `dialogue_${speaker}.${TAG}.rgba`), buf);
  console.log(`  dialogue_${speaker}.${TAG}  ${W}x${H}`);
}

// ── (B) 나레이션용 그린스크린 ───────────────────────────────────────
{
  const id = process.env.NARRATOR || 'P';
  const g = PLACE[id][TAG];
  const buf = Buffer.alloc(px);
  fill(buf, GREEN);
  const fh = g.frontH * H;
  const body = rasterH(join(charDir(id), 'front_body.svg'), fh);
  const [fx, fy] = place(body, g, 'front');
  blit(buf, body, fx, fy);
  blit(buf, rasterH(join(charDir(id), 'front_eyes_open.svg'), fh), fx, fy);
  blit(buf, rasterH(join(charDir(id), 'front_mouth_R.svg'), fh), fx, fy);
  writeFileSync(join(OUT, `green_${id}.${TAG}.rgba`), buf);
  console.log(`  green_${id}.${TAG}  ${W}x${H}  (키 색 ${GREEN})`);
}

writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ w: W, h: H, tag: TAG, green: GREEN }, null, 2));
console.log(`\n→ ${OUT} (raw RGBA, ffmpeg 로 PNG 변환 필요)`);
