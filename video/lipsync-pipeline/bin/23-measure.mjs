#!/usr/bin/env node
/**
 * 23-measure — 컷아웃을 실측해 **이후 단계가 쓰는 상수를 전부 뽑는다**
 *
 * 이 단계가 없으면 캐릭터가 바뀔 때마다 사람이 15개쯤을 손으로 재야 한다
 * (bbox / 입 ROI / 눈 ROI / 귀 절단 위치 / 귀 끝 높이 / 입 열린 그림이 뭔지).
 * 전부 픽셀에서 나오는 값이므로 자동으로 뽑는다.  → build/measured.json
 *
 * 판정 규칙 (전부 실측으로 확정)
 *  · 입/눈 구분 : **가로 중심 기준.** 입은 중심에 붙어 있고(|Δcx| < 0.15·반폭),
 *    눈은 좌우로 벌어져 있다. y 좌표로 나누면 토리처럼 눈이 낮은 캐릭터에서 틀린다(실측).
 *  · 입 열린 그림 : 기본 대비 차이에서 **입 면적/눈 면적 비가 가장 큰** 표정.
 *    파일명(설명/입벌림/talk…)은 캐릭터마다 달라 믿을 수 없다.
 *  · 눈 ROI 분리 : 입 ROI 사각형과 눈 ROI 사각형이 **겹치면** 좌/우로 쪼갠다
 *    (토리는 겹치고 너굴은 안 겹친다 — 캐릭터마다 다르므로 자동 판정해야 한다).
 *  · 귀 절단 : 컨텐츠 첫 행에 폭 ≥ 8% 인 구간이 2개면 "양쪽 귀가 잘림".
 *  · 귀 끝 높이 K : 절단면 폭 W0 와 폭 증가율 g 로 타원이 가질 수 있는 최대 높이가
 *    W0/(2g) 이다. 그 95%(EARF)를 쓴다 — 실제 영상 1:1 로 확인해 확정한 값이다.
 *    ⚠️ K 는 **확대해서 정하면 반드시 틀린다.** 새 캐릭터에서는 1:1 로 한 번 확인할 것.
 *  · trimTop : 첫 15행에서 폭이 줄었다 늘면 윗행이 지저분한 것이다 → 그만큼 잘라낸다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => { try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {} return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'); })();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');
const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const CAST = arg('cast') || 'input/cast.json';
const DIR = arg('dir') || 'build/cast';
const OUT = arg('out') || 'build/measured.json';
// 0.95 = 실제 영상 1:1 로 확인해 확정한 값(너굴 K=40). §8.6 의 K45 뾰족/K24 눌림 사이.
const EARF = +(arg('earf') || 0.95);
const cast = JSON.parse(readFileSync(CAST, 'utf8'));

const dim = f => execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', f], { encoding: 'utf8' }).trim().split('x').map(Number);
const rd = (f, w, h) => Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: w * h * 4 + 8192 }));
const bbox = (b, W, H) => { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b[(y * W + x) * 4 + 3] > 32) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };

/** 두 이미지의 차이 덩어리 */
function diffBlobs(A, B, W, H, TH = 40, MIN = 150) {
  const d = i => Math.max(Math.abs(A[i * 4] - B[i * 4]), Math.abs(A[i * 4 + 1] - B[i * 4 + 1]),
    Math.abs(A[i * 4 + 2] - B[i * 4 + 2]), Math.abs(A[i * 4 + 3] - B[i * 4 + 3]));
  const seen = new Uint8Array(W * H), out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (seen[i] || d(i) <= TH) continue;
    const st = [i]; seen[i] = 1; let n = 0, x0 = x, x1 = x, y0 = y, y1 = y;
    while (st.length) {
      const p = st.pop(), px = p % W, py = (p - px) / W; n++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (seen[q] || d(q) <= TH) continue;
        seen[q] = 1; st.push(q);
      }
    }
    // ⚠️ 크기만으로 거르면 **전 화면에 흩어진 안티에일리어싱 차이**가 하나의 거대한
    //    덩어리로 이어져 ROI 가 화면 전체가 된다(실측: 토리 입 ROI 가 1380x752 전체).
    //    실제 부위는 조밀하고(밀도 0.25~0.31) 잡음은 성기다(0.003~0.005). 밀도로 가른다.
    const dens = n / ((x1 - x0 + 1) * (y1 - y0 + 1));
    if (n >= MIN && dens >= 0.10) out.push({ n, x0, y0, x1, y1, dens, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }
  return out;
}
/** 행별 알파 구간 (좁은 조각은 흡수) */
function runs(b, W, y, gap = 30, min = 8) {
  const r = []; let s = -1;
  for (let x = 0; x < W; x++) {
    const on = b[(y * W + x) * 4 + 3] > 32;
    if (on && s < 0) s = x;
    if (!on && s >= 0) { if (x - s >= min) r.push([s, x - 1]); s = -1; }
  }
  if (s >= 0) r.push([s, W - 1]);
  const m = [];
  for (const x of r) { if (m.length && x[0] - m[m.length - 1][1] <= gap) m[m.length - 1][1] = x[1]; else m.push([...x]); }
  return m;
}
/** 귀 측정: 절단 여부 · 구간 · 폭 증가율 · 끝 높이 K · 윗행 정리량 */
function ears(b, W, H, box) {
  const cw = box[2] - box[0] + 1;
  // ── 윗행이 지저분한지 판정한다.
  // ⚠️ **양쪽 귀 폭의 합으로 재면 안 된다.** 한쪽만 줄고 다른 쪽이 늘면 합계는 계속 늘어
  //    감지에 실패한다(실측: 뒤통수 좌측 귀가 190→182 로 주는데 합계는 증가 → trim=0 →
  //    흰 잔재가 그대로 귀 끝까지 늘어남). **귀마다 따로** 본다.
  const rowRuns = y => runs(b, W, y).filter(r => r[1] - r[0] + 1 >= cw * 0.08);
  let trim = 0;
  {
    const first = rowRuns(0);
    for (const sp0 of first) {
      const c0 = (sp0[0] + sp0[1]) / 2;
      let w0 = sp0[1] - sp0[0] + 1, minW = w0, minY = 0;
      for (let y = 1; y < Math.min(15, H); y++) {
        const rs = rowRuns(y);
        let bestR = null, bd = 1e9;
        for (const r of rs) { const d2 = Math.abs((r[0] + r[1]) / 2 - c0); if (d2 < bd) { bd = d2; bestR = r; } }
        if (!bestR || bd >= 60) break;
        const w = bestR[1] - bestR[0] + 1;
        if (w < minW) { minW = w; minY = y; }
      }
      if (w0 - minW >= 3 && minY > trim) trim = minY;   // 3px 이상 줄어들면 그 구간은 신뢰 못 함
    }
    // ⚠️ 폭 추세만으로는 부족하다. **원본 아트에 박힌 잔재**가 있는 행을 직접 찾는다.
    //    잔재 = 구간 안쪽의 **근사 순백 픽셀이 한 행에 20px 이상**. 임계를 낮추면
    //    크림색 귀 테두리까지 걸려 앞모습 귀가 통째로 오판된다(실측 205/26 → 실패).
    //    (실측: 너굴 뒤통수 y0~8 에 흰 조각 → trim 10 이어야 사라진다)
    let dirty = -1;
    for (let y = 0; y < Math.min(20, H); y++) {
      let white = 0;
      for (const r of rowRuns(y)) {
        for (let x = r[0] + 1; x < r[1]; x++) {
          const o = (y * W + x) * 4;
          const mx = Math.max(b[o], b[o + 1], b[o + 2]), mn = Math.min(b[o], b[o + 1], b[o + 2]);
          if (b[o + 3] > 32 && mn > 225 && mx - mn < 14) white++;
        }
      }
      if (white >= 20) dirty = y;      // 20px 미만은 안티에일리어싱 수준 → 무시
    }
    if (dirty >= 0) trim = Math.max(trim, dirty + 2);
  }
  const y0 = trim;
  const R = runs(b, W, y0).filter(r => r[1] - r[0] + 1 >= cw * 0.08);
  if (R.length !== 2) return { cut: false, trimTop: trim, note: `첫 행 구간 ${R.length}개 → 양쪽 귀 절단으로 보기 어려움` };
  const spans = R.map(r => [r[0], r[1]]);
  const W0 = spans.map(s => s[1] - s[0] + 1);
  // 폭 증가율: 각 귀를 아래로 12행 추적
  // ⚠️ 끝점 두 개로 기울기를 재면 안 된다. 아래로 내려가면 **정수리 털이 다리를 놓아**
  //    구간이 갑자기 넓어져 기울기가 2배로 잡힌다(실측: 오른쪽 귀 1.78 → 3.17).
  //    행당 증가량의 **중앙값**을 쓰고, 한 행에 8px 넘게 튀면 그 지점에서 추적을 끊는다.
  const g = spans.map((sp) => {
    const c0 = (sp[0] + sp[1]) / 2;
    let prev = sp[1] - sp[0] + 1;
    const inc = [];
    for (let y = y0 + 1; y <= y0 + 8 && y < H; y++) {
      const rs = runs(b, W, y);
      let bestR = null, bd = 1e9;
      for (const r of rs) { const d2 = Math.abs((r[0] + r[1]) / 2 - c0); if (d2 < bd) { bd = d2; bestR = r; } }
      if (!bestR || bd >= 60) break;
      const w = bestR[1] - bestR[0] + 1;
      if (w - prev > 8) break;
      inc.push(w - prev); prev = w;
    }
    if (!inc.length) return 2;
    inc.sort((p, q) => p - q);
    return Math.max(0.2, inc[inc.length >> 1]);
  });
  const Ks = W0.map((w, i) => w / (2 * g[i]));
  const K = Math.round(EARF * (Ks.reduce((s2, v) => s2 + v, 0) / Ks.length));
  return { cut: true, trimTop: trim, spans, W0, slope: g.map(v => +v.toFixed(2)), K };
}

const M = {};
for (const [sid, sp] of Object.entries(cast.speakers)) {
  const exprs = Object.keys(sp.front);
  const neutral = sp.neutral;
  const f0 = join(DIR, `${sid}_${neutral}.png`);
  const [W, H] = dim(f0);
  const base = rd(f0, W, H);
  const box = bbox(base, W, H);
  const cx = (box[0] + box[2]) / 2, half = (box[2] - box[0]) / 2;

  const per = {};
  const yBot = box[1] + (box[3] - box[1]) * 0.85;     // 이 아래는 목·어깨·넥타이다
  for (const e of exprs) {
    if (e === neutral) continue;
    let blobs = diffBlobs(base, rd(join(DIR, `${sid}_${e}.png`), W, H), W, H);
    // ⚠️ 작은 덩어리를 남기면 ROI 가 부풀어 엉뚱한 데까지 덮는다(실측: 너굴 입 ROI 가
    //    눈썹까지 올라감). 그 표정에서 **가장 큰 덩어리의 15% 미만**은 버린다.
    const big = Math.max(...blobs.map(b2 => b2.n), 1);
    blobs = blobs.filter(b2 => b2.n >= big * 0.15 && b2.cy <= yBot);
    const mouth = blobs.filter(b2 => Math.abs(b2.cx - cx) < 0.15 * half);
    const eye = blobs.filter(b2 => Math.abs(b2.cx - cx) >= 0.15 * half);
    per[e] = { mouth: mouth.reduce((s, b2) => s + b2.n, 0), eye: eye.reduce((s, b2) => s + b2.n, 0), blobs, mouthB: mouth, eyeB: eye };
  }
  if (arg('debug')) for (const [e, v] of Object.entries(per)) {
    console.log(`  [debug ${sid} ${neutral}→${e}]`);
    for (const b2 of v.blobs) console.log(`     ${Math.abs(b2.cx - cx) < 0.15 * half ? '입' : '눈'} ${String(b2.n).padStart(6)}px  x${b2.x0}-${b2.x1} y${b2.y0}-${b2.y1}  Δcx=${Math.round(Math.abs(b2.cx - cx))} 밀도=${b2.dens.toFixed(2)}`);
  }
  const mouthOpenFrom = Object.entries(per).sort((p, q) => (q[1].mouth / (q[1].eye + 1)) - (p[1].mouth / (p[1].eye + 1)))[0]?.[0] || null;

  // ── 표정마다 **입이 열린 그림인지** 판정한다.
  // ⚠️ 이걸 안 하면 '놀람'처럼 입이 벌어진 표정을 closed 프레임으로 써서 입이 늘 열려 있게 된다.
  //    판정: 입 영역 차이의 **세로 높이**가 입벌림 그림의 85% 이상이면 그 표정도 입이 열린 것.
  //    (실측 너굴 경고 70/97=0.72 → 닫힘, 토리 놀람 136/128=1.06 → 열림)
  const mh = e => { const b2 = per[e]?.mouthB || []; return b2.length ? Math.max(...b2.map(v => v.y1)) - Math.min(...b2.map(v => v.y0)) : 0; };
  const openH = mouthOpenFrom ? mh(mouthOpenFrom) : 0;
  const mouthOpen = {};
  for (const e of exprs) mouthOpen[e] = e === mouthOpenFrom ? true : (openH > 0 && mh(e) >= openH * 0.85);

  // ── 표정마다 **자기 눈 프레임이 필요한지** 판정한다.
  // ⚠️ '설명'처럼 눈은 기본과 같고 입만 열린 표정은 별도 프레임을 만들면 안 된다.
  //    입 열림은 발음에서 나오므로, 표정으로 또 열면 입이 두 겹으로 보인다(§8.6).
  //    → 눈 차이가 최대치의 30% 미만이면 기본으로 접는다.
  const ea = e => per[e]?.eye || 0;
  const maxEye = Math.max(...exprs.map(ea), 1);
  const foldsToNeutral = {};
  for (const e of exprs) foldsToNeutral[e] = e === neutral ? false : ea(e) < maxEye * 0.3;

  const un = (bs, pad) => bs.length ? [Math.min(...bs.map(b2 => b2.x0)) - pad, Math.min(...bs.map(b2 => b2.y0)) - pad,
    Math.max(...bs.map(b2 => b2.x1)) + pad, Math.max(...bs.map(b2 => b2.y1)) + pad] : null;
  const allMouth = Object.values(per).flatMap(v => v.mouthB);
  const allEye = Object.values(per).flatMap(v => v.eyeB);
  const mouthROI = un(allMouth, 20);
  let eyeROI = un(allEye, 20) ? [un(allEye, 20)] : [];
  // 사각형이 겹치면 좌/우로 쪼갠다
  if (mouthROI && eyeROI.length === 1) {
    const [ex0, ey0, ex1, ey1] = eyeROI[0];
    const ov = !(mouthROI[2] < ex0 || mouthROI[0] > ex1 || mouthROI[3] < ey0 || mouthROI[1] > ey1);
    if (ov) {
      const L = allEye.filter(b2 => b2.cx < cx), R2 = allEye.filter(b2 => b2.cx >= cx);
      eyeROI = [un(L, 20), un(R2, 20)].filter(Boolean);
    }
  }

  // ── 사람이 지정한 예외값. 원본 아트에 결함이 있어 자동 판정이 못 미치는 경우에만 쓴다.
  //    cast.json → speakers[ID].overrides = { trimTop, K, backTrimTop, backK }
  const ov = sp.overrides || {};
  const front = ears(base, W, H, box);
  if (ov.trimTop != null) front.trimTop = ov.trimTop;
  if (ov.K != null) front.K = ov.K;
  const backF = join(DIR, `${sid}_back.png`);
  let back = null;
  try {
    const [bw, bh] = dim(backF); const bb = rd(backF, bw, bh); const bx = bbox(bb, bw, bh);
    const be = ears(bb, bw, bh, bx);
    // ⚠️ 뒤통수는 귀 옆면이 거의 수직이라 기울기가 0 에 가깝게 잡혀 K 가 폭주한다
    //    (실측 K=216). **같은 캐릭터이므로 앞모습의 K/W0 비율을 그대로 쓴다.**
    if (be.cut && front.cut) {
      const r = front.K / (front.W0.reduce((s2, v) => s2 + v, 0) / front.W0.length);
      be.K = Math.round(r * (be.W0.reduce((s2, v) => s2 + v, 0) / be.W0.length));
      be.KFrom = '앞모습 비율';
    }
    if (ov.backTrimTop != null) be.trimTop = ov.backTrimTop;
    if (ov.backK != null) be.K = ov.backK;
    back = { bbox: bx, ears: be };
  } catch {}

  M[sid] = { name: sp.name, neutral, exprs, mouthOpenFrom, mouthOpen, foldsToNeutral, bbox: box, mouthROI, eyeROI, ears: front, back };
  sp.mouthOpenFrom = mouthOpenFrom;
}
writeFileSync(OUT, JSON.stringify(M, null, 2) + '\n');
writeFileSync(CAST, JSON.stringify(cast, null, 2) + '\n');

for (const [sid, m] of Object.entries(M)) {
  console.log(`\n[${sid}] ${m.name}`);
  console.log(`  bbox        ${m.bbox.join(', ')}`);
  console.log(`  입 열린 그림  ${m.mouthOpenFrom}`);
  console.log(`  표정별 입     ${m.exprs.map(e => `${e}:${m.mouthOpen[e] ? '열림' : '닫힘'}`).join('  ')}`);
  console.log(`  독립 표정     ${m.exprs.filter(e => !m.foldsToNeutral[e]).join(', ')}   (나머지는 기본으로 접힘)`);
  console.log(`  입 ROI      ${m.mouthROI?.join(',')}`);
  console.log(`  눈 ROI      ${m.eyeROI.map(r => r.join(',')).join('  |  ')}${m.eyeROI.length > 1 ? '   (입 ROI 와 겹쳐 좌/우 분리)' : ''}`);
  const e = m.ears;
  console.log(`  귀          ${e.cut ? `절단됨. 구간 ${e.spans.map(s => s.join('-')).join(' ')}  W0 ${e.W0.join('/')}  증가율 ${e.slope.join('/')}  → K=${e.K}${e.trimTop ? `  윗행 ${e.trimTop} 잘라낼 것` : ''}` : `잘리지 않음 (${e.note || ''})`}`);
  if (m.back) console.log(`  뒤통수       bbox ${m.back.bbox.join(', ')}  귀 ${m.back.ears.cut ? `K=${m.back.ears.K}${m.back.ears.trimTop ? ` / 윗행 ${m.back.ears.trimTop} 잘라낼 것` : ''}` : '잘리지 않음'}`);
}
console.log(`\n✓ ${OUT}  (cast.json 의 mouthOpenFrom 도 채웠습니다)`);
