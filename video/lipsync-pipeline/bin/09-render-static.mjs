#!/usr/bin/env node
/**
 * 09-render-static — 캐릭터를 **완전히 고정**하고 눈·입만 움직이는 렌더러
 *
 * 왜 생성형(Flyworks)을 버렸나:
 *   생성형 립싱크는 매 프레임 얼굴을 **재생성**한다. 그 과정에서 캐릭터의 위치와
 *   크기가 미세하게 흔들리고, 클립마다 색·질감이 달라진다. 표정 클립을 갈아끼우면
 *   그 흔들림이 겹쳐 어색해진다. 아무리 색을 맞추고 디졸브를 걸어도 근본은 남는다.
 *
 * 이 렌더러의 원칙:
 *   · 캐릭터 이미지는 **한 좌표, 한 배율**로만 그린다. 이동·확대·바운스 전부 없음
 *   · 표정 이미지들은 08-align 으로 공통 bbox 에 정렬돼 있어 바꿔도 안 움직인다
 *   · **입**: 발음 세기(viseme)에 따라 "입 영역"만 열림/닫힘 이미지 사이로 블렌딩
 *   · **눈**: 대사의 표정 지시(기본/설명/경고/놀람)에 따라 베이스 이미지를 디졸브
 *
 * 입·눈 영역이 분리 가능한 근거: 같은 캐릭터의 표정 이미지끼리 차이를 재보면
 * **눈 영역과 입 영역에만** 차이가 있고 그 밖은 픽셀 단위로 동일하다(실측).
 * 그래서 입 영역만 잘라 덮어도 이음새가 생기지 않는다.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build'), OUT = join(ROOT, 'output');
mkdirSync(OUT, { recursive: true });
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');

const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

const MODE = process.env.MODE || 'closeup';          // closeup | dialogue
const [OW, OH] = [1080, 1920];
const FPS = 24;

const tl = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const vis = JSON.parse(readFileSync(join(BUILD, 'visemes.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(resolve(arg('config')), 'utf8'));
const nFrames = Math.ceil(tl.total * FPS);

// 발음 세기 → 입 열림 정도. 0=닫힘, 1=최대
const OPEN = { A: 1.0, E: 0.45, EO: 0.72, O: 0.82, U: 0.5, I: 0.25, M: 0.0, X: 0.08, R: 0.04 };
// 이 값 이상이면 "열림". 두 상태뿐이므로 경계를 여기서 정한다.
// ㅏㅗㅓㅜㅔ → 열림 / ㅣ·양순음받침·휴지 → 닫힘
const OPEN_TH = +(process.env.OPEN_TH || 0.40);

// ── 이미지 로드 (목표 크기로 미리 래스터화) ────────────────────────
function loadPng(file, targetH) {
  const [w, h] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' }).trim().split('x').map(Number);
  const tw = Math.round(w * (targetH / h));
  const px = execFileSync(FFMPEG, ['-v', 'error', '-i', file,
    '-vf', `scale=${tw}:${Math.round(targetH)}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: tw * targetH * 4 + 8192 });
  return { px, w: tw, h: Math.round(targetH), srcW: w, srcH: h };
}
function loadFull(file) {
  const px = execFileSync(FFMPEG, ['-v', 'error', '-i', file,
    '-vf', `scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: OW * OH * 4 + 8192 });
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return { px, w: OW, h: OH };
}

const chars = {};
for (const [id, c] of Object.entries(cfg.characters)) {
  const H = Math.round(c.height * OH);
  const imgs = {};
  for (const [k, f] of Object.entries(c.images)) imgs[k] = loadPng(resolve(f), H);
  const ref = imgs[c.base];
  // 입 영역을 원본 좌표 → 렌더 좌표로 환산
  const s = ref.h / ref.srcH;
  const mb = c.mouthBox.map((v, i) => Math.round(v * s));
  chars[id] = {
    id, imgs, base: c.base, open: c.open, expr: c.expr || {},
    w: ref.w, h: ref.h,
    x: Math.round(OW * c.x - ref.w / 2),
    y: Math.round(OH * c.bottom - ref.h),
    mouth: { x0: mb[0], y0: mb[1], x1: mb[2], y1: mb[3], feather: Math.round((c.mouthFeather || 24) * s) },
    back: c.back ? loadPng(resolve(c.back), Math.round((c.backHeight || c.height) * OH)) : null,
    backX: c.backX, backBottom: c.backBottom,
  };
  console.log(`  ${id}: ${ref.w}x${ref.h} @ (${chars[id].x},${chars[id].y})  표정 ${Object.keys(imgs).join('/')}`);
}

const bg = loadFull(resolve(cfg.background));
// ⚠️ 책상은 화면 **폭을 꽉 채워야** 한다. 높이 기준으로 스케일하면 폭이 모자라
// 좌우에 배경이 드러난다(실측: 1080 중 705px 만 덮음).
function loadStretch(file, w, h) {
  const px = execFileSync(FFMPEG, ['-v', 'error', '-i', file,
    '-vf', `scale=${w}:${h}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: w * h * 4 + 8192 });
  return { px, w, h, srcW: w, srcH: h };
}
const desk = cfg.desk ? loadStretch(resolve(cfg.desk), OW, Math.round(cfg.deskHeight * OH)) : null;

// 상단 띠: 컷아웃이 머리 위에서 잘려 있으면(소스 자체가 크롭된 경우) 그 평평한
// 절단선이 화면에 그대로 보인다. 숫자 카드가 놓이는 띠로 덮으면 자연스럽다.
// (원본 대화장면도 위는 책장, 아래는 책상으로 잘린 면을 가리는 구조다)
const topBar = cfg.topBar || null;

// ── 합성 프리미티브 ─────────────────────────────────────────────────
const PX = OW * OH * 4;
/**
 * 캐릭터 몸통을 아래로 연장한다.
 *
 * 컷아웃은 몸이 이미지 하단에서 잘려 있다. 책상을 현실적인 높이(원본 기준 프레임의
 * 34%)로 두면 잘린 단면과 책상 사이에 틈이 생긴다. 마지막 행을 아래로 복제해
 * 몸통을 이어 붙이면 그 틈이 메워진다. 조끼·셔츠·넥타이처럼 세로로 이어지는
 * 옷이면 자연스럽게 읽힌다.
 */
function extendBody(dst, src, dx, dy, toY) {
  const lastY = src.h - 1;
  for (let y = dy + src.h; y < toY; y++) {
    if (y < 0 || y >= OH) continue;
    let so = (lastY * src.w) * 4, to = (y * OW + dx) * 4;
    for (let x = 0; x < src.w; x++, so += 4, to += 4) {
      const tx = dx + x; if (tx < 0 || tx >= OW) continue;
      const a = src.px[so + 3];
      if (a === 0) continue;
      if (a === 255) { dst[to] = src.px[so]; dst[to + 1] = src.px[so + 1]; dst[to + 2] = src.px[so + 2]; }
      else {
        const f = a / 255, g = 1 - f;
        dst[to] = dst[to] * g + src.px[so] * f;
        dst[to + 1] = dst[to + 1] * g + src.px[so + 1] * f;
        dst[to + 2] = dst[to + 2] * g + src.px[so + 2] * f;
      }
      dst[to + 3] = 255;
    }
  }
}
function blit(dst, src, dx, dy, x0 = 0, y0 = 0, x1 = src.w - 1, y1 = src.h - 1) {
  for (let y = Math.max(y0, -dy); y <= Math.min(y1, OH - 1 - dy); y++) {
    let so = (y * src.w + Math.max(x0, -dx)) * 4;
    let to = ((dy + y) * OW + dx + Math.max(x0, -dx)) * 4;
    for (let x = Math.max(x0, -dx); x <= Math.min(x1, OW - 1 - dx); x++, so += 4, to += 4) {
      const a = src.px[so + 3];
      if (a === 0) continue;
      if (a === 255) { dst[to] = src.px[so]; dst[to + 1] = src.px[so + 1]; dst[to + 2] = src.px[so + 2]; }
      else {
        const f = a / 255, g = 1 - f;
        dst[to] = dst[to] * g + src.px[so] * f;
        dst[to + 1] = dst[to + 1] * g + src.px[so + 1] * f;
        dst[to + 2] = dst[to + 2] * g + src.px[so + 2] * f;
      }
      dst[to + 3] = 255;
    }
  }
}
/** 두 이미지를 t 비율로 섞어 그린다 (표정 디졸브) */
function blitMix(dst, a, b, t, dx, dy) {
  for (let y = Math.max(0, -dy); y < Math.min(a.h, OH - dy); y++) {
    let so = (y * a.w) * 4, to = ((dy + y) * OW + dx) * 4;
    for (let x = 0; x < a.w; x++, so += 4, to += 4) {
      const tx = dx + x; if (tx < 0 || tx >= OW) continue;
      const aa = a.px[so + 3] * (1 - t) + b.px[so + 3] * t;
      if (aa < 1) continue;
      const r = a.px[so] * (1 - t) + b.px[so] * t;
      const g = a.px[so + 1] * (1 - t) + b.px[so + 1] * t;
      const bl = a.px[so + 2] * (1 - t) + b.px[so + 2] * t;
      const f = aa / 255, ig = 1 - f;
      dst[to] = dst[to] * ig + r * f;
      dst[to + 1] = dst[to + 1] * ig + g * f;
      dst[to + 2] = dst[to + 2] * ig + bl * f;
      dst[to + 3] = 255;
    }
  }
}
/**
 * 입 영역을 열림 이미지로 **완전히 교체**한다.
 *
 * ⚠️ 부분 알파로 섞으면 안 된다. 중간값에서 닫힌 입과 열린 입이 **동시에 비쳐**
 *    이중 노출처럼 보인다(실측). 입 모양은 반드시 둘 중 하나여야 한다.
 *    가장자리 페더는 유지하되, 그 구간은 두 이미지가 이미 동일한 영역이므로
 *    겹쳐 보이지 않는다(차이는 입 안쪽에만 있다).
 */
function blendMouth(dst, C, openImg, isOpen, dx, dy) {
  if (!isOpen) return;
  const { x0, y0, x1, y1, feather } = C.mouth;
  for (let y = y0; y <= y1; y++) {
    const ty = dy + y; if (ty < 0 || ty >= OH) continue;
    const fy = Math.min(1, Math.min(y - y0, y1 - y) / Math.max(1, feather));
    for (let x = x0; x <= x1; x++) {
      const tx = dx + x; if (tx < 0 || tx >= OW) continue;
      const fx = Math.min(1, Math.min(x - x0, x1 - x) / Math.max(1, feather));
      const w = fx * fy;
      if (w <= 0.004) continue;
      const so = (y * C.w + x) * 4, to = (ty * OW + tx) * 4;
      const a = openImg.px[so + 3] / 255;
      if (a < 0.01) continue;
      const m = w * a, ig = 1 - m;
      dst[to] = dst[to] * ig + openImg.px[so] * m;
      dst[to + 1] = dst[to + 1] * ig + openImg.px[so + 1] * m;
      dst[to + 2] = dst[to + 2] * ig + openImg.px[so + 2] * m;
    }
  }
}

// ── 대사/표정 스케줄 ────────────────────────────────────────────────
const EXPR_FADE = +(arg('exprfade') || 0.45);   // 표정 디졸브 길이(초)
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
/** 시각 t 에서 화자의 표정 이미지 키와, 직전 표정에서의 전이 비율 */
function exprAt(C, t) {
  let prev = null, cur = tl.lines.find(L => L.spk === C.id) || tl.lines[0], switchT = 0;
  for (const L of tl.lines) {
    if (L.spk !== C.id) continue;
    if (t >= L.start - 0.15) {
      const k = C.expr[L.bg] || C.base;
      const ck = C.expr[cur.bg] || C.base;
      if (k !== ck) { prev = ck; switchT = L.start - 0.15; }
      cur = L;
    } else break;
  }
  const key = C.expr[cur.bg] || C.base;
  if (!prev || t - switchT >= EXPR_FADE) return [key, key, 1];
  return [prev, key, Math.max(0, Math.min(1, (t - switchT) / EXPR_FADE))];
}

// ── 렌더 ────────────────────────────────────────────────────────────
const name = arg('name') || `static_${MODE}`;
const outFile = join(OUT, `${name}.mp4`);
const assPath = join(BUILD, 'captions.ass').replace(/([:\\])/g, '\\$1');

const ff = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${OW}x${OH}`, '-framerate', String(FPS), '-i', 'pipe:0',
  '-i', join(BUILD, 'master.wav'),
  '-filter_complex', `[0:v]ass='${assPath}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
  '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile],
  { stdio: ['pipe', 'inherit', 'inherit'] });

let written = 0;
const openStat = {};
for (let f = 0; f < nFrames; f++) {
  const t = f / FPS;
  const L = lineAt(t);
  const buf = Buffer.allocUnsafe(PX);
  bg.px.copy(buf);

  const spk = MODE === 'dialogue' ? L.spk : (arg('narrator') || L.spk);
  const S = chars[spk];
  const listener = MODE === 'dialogue' ? Object.values(chars).find(c => c.id !== spk) : null;

  // 화자: 표정 베이스 (전환 시 디졸브) — 좌표·배율은 항상 동일
  const [k0, k1, mix] = exprAt(S, t);
  // 잘린 몸통을 책상 상단까지 이어 붙인다
  if (cfg.bodyExtendTo) extendBody(buf, S.imgs[mix >= 1 ? k1 : k0], S.x, S.y, Math.round(OH * cfg.bodyExtendTo));
  if (mix >= 1 || k0 === k1) blit(buf, S.imgs[k1], S.x, S.y);
  else blitMix(buf, S.imgs[k0], S.imgs[k1], mix, S.x, S.y);

  // 입: 열림/닫힘 **둘 중 하나**로만 판정한다 (중간값 = 이중 노출이므로 금지)
  const key = mouthFrames[S.id]?.[Math.min(vis.totalFrames - 1, Math.floor(t * vis.fps))] || 'R';
  const isOpen = (OPEN[key] ?? 0) >= OPEN_TH;
  blendMouth(buf, S, S.imgs[S.open], isOpen, S.x, S.y);
  const st = isOpen ? '열림' : '닫힘'; openStat[st] = (openStat[st] || 0) + 1;

  // 책상 전경 — 캐릭터 하단 절단면을 가린다
  if (desk) blit(buf, desk, 0, Math.round(OH * cfg.deskBottom - desk.h));

  // 상단 띠 — 캐릭터 상단 절단면을 가린다
  if (topBar) {
    const h = Math.round(topBar.height * OH);
    const [r, g, b] = topBar.color;
    const edge = Math.round(topBar.edge ?? 6);
    for (let y = 0; y < h + edge; y++) {
      const isEdge = y >= h;
      const er = isEdge ? topBar.edgeColor[0] : r;
      const eg = isEdge ? topBar.edgeColor[1] : g;
      const eb = isEdge ? topBar.edgeColor[2] : b;
      for (let x = 0; x < OW; x++) {
        const o = (y * OW + x) * 4;
        buf[o] = er; buf[o + 1] = eg; buf[o + 2] = eb; buf[o + 3] = 255;
      }
    }
  }

  // 청자 뒷모습 — 책상보다 **앞**에 온다. 카메라와 가장 가까운 레이어라
  // 책상 뒤에 두면 오버더숄더가 성립하지 않는다. 위치·배율은 완전 고정.
  if (listener?.back) {
    const bx = Math.round(OW * listener.backX - listener.back.w / 2);
    const by = Math.round(OH * listener.backBottom - listener.back.h);
    blit(buf, listener.back, bx, by);
    extendBody(buf, listener.back, bx, by, OH);   // 프레임 하단까지 이어 붙인다
  }

  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  if (++written % 240 === 0) process.stderr.write(`  ${written}/${nFrames}\n`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));

console.log(`\n✅ ${outFile}`);
console.log(`   ${OW}x${OH} @ ${FPS}fps / ${nFrames}프레임 / ${tl.total.toFixed(2)}s`);
console.log(`   입모양 분포: ${Object.entries(openStat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`);
