#!/usr/bin/env node
/**
 * 16-rebuild-ears — 평평하게 잘린 **귀 끝만** 컷아웃 자신의 픽셀로 이어 붙인다
 *
 * ⚠️ 왜 장면 이미지에서 떼어오면 안 되는가 (실측으로 폐기된 방법):
 *   장면의 캐릭터와 클로즈업 컷아웃은 별개 생성물이라 **머리 비율이 다르다.**
 *   동공 두 점으로 상사변환을 맞춰 겹쳐 보면 컷아웃 머리가 장면 머리보다 넓고
 *   귀 위치도 어긋난다(실측). 그 상태로 이어 붙이면 이음매에서 **두 모양이 겹쳐 보인다.**
 *   교차 페이드(blend)를 주면 두 털 무늬가 반투명으로 포개져 더 나빠진다.
 *
 * ⚠️ 먼저 **무엇이 잘렸는지 알파 행 프로파일로 확인할 것.** 머리 전체가 잘린 줄 알았는데
 *   실제로는 귀 끝 두 군데만 잘려 있었다(실측):
 *     y=0   288-456  952-1119   ← 귀 두 개만. 가운데는 비어 있다
 *     y=10  …638-662…           ← 정수리 털끝이 이때 나타남 = 정수리는 온전
 *   복원 범위를 최소로 잡을수록 티가 안 난다.
 *
 * 방식: 잘린 단면 아래의 귀 단면들을 위로 올리면서 **가로로 좁혀** 끝을 만든다.
 *   - 윤곽  **원화의 완전한 귀에서 좌·우 경계를 따로 추적해 뜬 프로파일**을 쓴다.
 *             폭과 **중심 이동**을 함께 준다. 중심 고정 대칭 타원은 틀린다(아래 참조).
 *   - 내용  아래쪽 단면을 목표 폭에 맞춰 가로로 눌러 담는다
 *     → 귓속(밝은 부분)이 끝으로 갈수록 자연스럽게 좁아진다.
 *   모든 픽셀이 **같은 그림에서** 오므로 색·질감이 어긋날 수가 없다.
 *
 * ⚠️⚠️ **귀는 좌우 대칭으로 좁아지지 않는다.** 원화 실측(격자로 좌/우 경계 개별 추적):
 *     바깥(외측) 경계 … 거의 수직        (-0.18 px/행)
 *     안쪽(내측) 경계 … 크게 안으로 쓸림 (+1.43 px/행)
 *   즉 **안쪽에서만 좁아지고 끝은 바깥쪽으로 치우친다.** 중심이 W0 의 약 10%(≈17px)
 *   바깥으로 이동한다. 중심을 고정하면 끝 방향이 가운데로 서서 "이상해" 보인다(실측 반려).
 *
 * ⚠️ 형태를 감으로 정하지 말 것. **원화에서 귀 옆면 폭을 실측해 프로파일을 떠라.**
 *   너굴 실측(원화 좌표, 끝에서 아래로): 0/10/20/30/40/50/60px → 폭 20/68/89/103/113/118/121
 *   절단면 폭 169 와 맞물리는 지점을 잡아 3점으로 타원을 풀면
 *     a=97.8  b=91.1  c=45.8  → 귀 끝은 절단면 위 **45px**, 가로세로비 1.074 (거의 원)
 *   실패한 시도들:
 *     · W0·sqrt(1-(k/K)²)  … 위가 평평한 돔이 얹혀 **여우 귀**처럼 길어졌다
 *     · W0·(1-k/K)^0.8     … 끝이 **뾰족한 삼각형**이 됐다. 원화는 둥글다
 *   폭이 절단면 근처에서는 천천히, 끝에서 급히 줄어드는 **볼록한** 곡선이어야 한다.
 *
 * ⚠️ 중심 이동을 안쪽 가장자리로 재면 안 된다. 안쪽은 정수리 털이 다리를 놓아
 *   실제보다 크게 벌어진 것처럼 측정된다(실측 1.0px/행). 원화에서는 중심이 거의 고정이다.
 *
 * 사용: node bin/16-rebuild-ears.mjs <입력> <출력> [--k 95] [--ears "288,456 952,1119"]
 *   --ears 를 주면 자동 검출 대신 그 값을 쓴다. **여러 파일에 같은 값을 주어야**
 *   결과물의 알파 bbox 가 같아져 정렬이 유지된다.
 */
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const files = a.filter((v, i) => !v.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
const [IN, OUT] = files;
// --k / --ratio 를 주면 그 값을 쓰고, 안 주면 **그려진 귀의 곡률에서 직접 푼다**(권장).
const K_ARG = arg('k') ? +arg('k') : null;
const RATIO_ARG = arg('ratio') ? +arg('ratio') : null;
const FITROWS = +(arg('fitrows') || 12); // 곡률을 잴 구간 (정수리 털이 다리 놓기 전까지)
const FIT = +(arg('fit') || 12);        // 바깥 윤곽선 기울기를 잴 구간 (짧게: 아래는 오염된다)
// ⚠️ DEPTH>0 이면 **이음선 아래 무늬가 위에 다시 재생된다.** 귓속 어두운 부분이 두 번
//    나와 "이어지는 부분과 그 위가 이상하다"가 된다(실측). 기본 0 = 단면 하나만 눌러 잇는다.
const DEPTH = +(arg('depth') || 0);
// ⚠️ SKIP>0 은 k=0 에서도 그만큼 아래 단면을 가져와 **이음선에 가로 줄**을 만든다.
//    지저분한 윗행은 SKIP 이 아니라 **원본을 미리 crop 해서** 버릴 것.
const SKIP = +(arg('skip') || 0);
const RIM = +(arg('rim') || 6);         // 바깥 윤곽선 두께(px). 이 띠는 **눌러 담지 않는다**
const SMOOTH = +(arg('smooth') || 26);  // 끝으로 갈수록 띠 안에서 흐리게 (세로 줄무늬 제거)
const SEED = 1234567;

const [W, H] = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', IN], { encoding: 'utf8' }).trim().split('x').map(Number);
const src = Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', IN,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: W * H * 4 + 8192 }));
const A = (x, y) => src[(y * W + x) * 4 + 3];

// ⚠️ 컷아웃 상단에 **순백 얼룩**이 남아 있는 경우가 있다(체커 제거 잔재로 추정).
//    실측: close_04_뒤통수 x459-476 y0-8 (66px). 그냥 두면 귀 재구성이 이 얼룩을
//    끝까지 늘려 하얀 쐐기로 만든다. 재구성 전에 지운다.
//    판정은 좁게: 알파가 있고 거의 무채색이며 아주 밝은 픽셀만.
// ⚠️ 알파를 0 으로 지우면 안 된다. 그 자리가 **구멍**이 되어 재구성한 귀가 찢어진다(실측).
//    아래쪽의 성한 픽셀 색으로 **메꾼다**.
if (arg('despeck') !== '0') {
  const band = +(arg('despeck-rows') || 60);
  const isSpeck = (o) => {
    if (src[o + 3] <= 32) return false;
    const mx = Math.max(src[o], src[o + 1], src[o + 2]);
    const mn = Math.min(src[o], src[o + 1], src[o + 2]);
    return mn > 225 && mx - mn < 14;
  };
  let cleaned = 0;
  for (let y = 0; y < Math.min(band, H); y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (!isSpeck(o)) continue;
    for (let yy = y + 1; yy < Math.min(band + 40, H); yy++) {
      const p2 = (yy * W + x) * 4;
      if (src[p2 + 3] > 32 && !isSpeck(p2)) {
        src[o] = src[p2]; src[o + 1] = src[p2 + 1]; src[o + 2] = src[p2 + 2];
        cleaned++; break;
      }
    }
  }
  if (cleaned) console.log(`  흰 얼룩 ${cleaned}px 메꿈`);
}

/** 한 행의 알파 구간들 (좁은 잡음은 버린다) */
function runs(y, min = 8) {
  const r = []; let s = -1;
  for (let x = 0; x < W; x++) {
    const on = A(x, y) > 32;
    if (on && s < 0) s = x;
    if (!on && s >= 0) { if (x - s >= min) r.push([s, x - 1]); s = -1; }
  }
  if (s >= 0) r.push([s, W - 1]);
  return r;
}
/** 안티에일리어싱으로 끊긴 조각을 이어 붙인다 */
function merge(r, gap = 30) {
  const o = [];
  for (const x of r) {
    if (o.length && x[0] - o[o.length - 1][1] <= gap) o[o.length - 1][1] = x[1];
    else o.push([...x]);
  }
  return o;
}

let ears = arg('ears')
  ? arg('ears').trim().split(/\s+/).map(s => s.split(',').map(Number))
  : merge(runs(0)).filter(r => r[1] - r[0] >= 60);
if (ears.length !== 2) throw new Error(`귀 두 개를 찾지 못했습니다: ${JSON.stringify(ears)}`);
console.log(`  귀 단면 y=0: ${ears.map(e => `${e[0]}-${e[1]}`).join('  ')}`);

/** 각 귀에 대해 아래로 내려가며 단면을 추적한다 (정수리와 합쳐지면 중단) */
function track(ear) {
  const C0 = (ear[0] + ear[1]) / 2, W0 = ear[1] - ear[0] + 1;
  const rows = [{ y: 0, l: ear[0], r: ear[1] }];
  for (let y = 1; y < H; y++) {
    const rs = merge(runs(y));
    if (!rs.length) break;
    const prev = rows[rows.length - 1];
    const pc = (prev.l + prev.r) / 2;
    let best = null, bd = 1e9;
    for (const x of rs) { const d = Math.abs((x[0] + x[1]) / 2 - pc); if (d < bd) { bd = d; best = x; } }
    if (!best || bd > 60) break;
    if (best[1] - best[0] + 1 > W0 * 2.2) break;      // 정수리와 합쳐졌다
    rows.push({ y, l: best[0], r: best[1] });
  }
  // ── 귀 끝은 **그려진 폭 곡선에서 푼다.** 감으로 정하면 반드시 틀린다(실측 2회 반려).
  //    타원 W(y) = 2a·sqrt(1-((c-y)/b)²) 는 (W/2)² 이 y 의 **2차식**이라는 뜻이다:
  //       (W/2)² = A + B·y + C·y²,  c = -B/2C,  a² = A - C·c²,  b² = a²/(-C)
  //    절단면 아래 몇 행만 최소제곱으로 맞추면 a,b,c 가 나오고, 끝 높이는 K = b - c.
  //    → 그림에 실제로 그려진 곡률을 그대로 이어 붙이게 된다.
  let a, b, c, K;
  if (K_ARG && RATIO_ARG) {
    const M = Math.pow(W0 / (2 * RATIO_ARG * K_ARG), 2);
    const q = 2 / (M + 1);
    b = K_ARG / q; c = b - K_ARG; a = RATIO_ARG * b; K = K_ARG;
  } else {
    const pts = rows.filter(r => r.y <= FITROWS).map(r => [r.y, Math.pow((r.r - r.l + 1) / 2, 2)]);
    if (pts.length < 4) throw new Error('곡률을 맞출 행이 부족합니다');
    let n = 0, sy = 0, sy2 = 0, sy3 = 0, sy4 = 0, su = 0, syu = 0, sy2u = 0;
    for (const [y, u] of pts) {
      n++; sy += y; sy2 += y * y; sy3 += y ** 3; sy4 += y ** 4;
      su += u; syu += y * u; sy2u += y * y * u;
    }
    // 3x3 정규방정식을 크래머 공식으로 푼다
    const M3 = [[n, sy, sy2], [sy, sy2, sy3], [sy2, sy3, sy4]];
    const V = [su, syu, sy2u];
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                     - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                     + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const rep = (m, i) => m.map((row, r) => row.map((v, cc) => (cc === i ? V[r] : v)));
    const D = det(M3);
    const A = det(rep(M3, 0)) / D, B = det(rep(M3, 1)) / D, C = det(rep(M3, 2)) / D;
    if (C >= 0) throw new Error('폭 곡선이 아래로 볼록하지 않습니다 (구간을 줄여보세요)');
    c = -B / (2 * C);
    a = Math.sqrt(A - C * c * c);
    b = Math.sqrt((a * a) / -C);
    K = b - c;
  }
  return { C0, W0, rows, a, b, c, K, outerIsLeft: C0 < W / 2 };
}
/**
 * 원화(완전한 귀)에서 6배 격자로 좌·우 경계를 개별 추적해 뜬 프로파일.
 *   f = 절단면에서 끝까지의 비율, W = 폭/W0, C = 중심이 **바깥으로** 이동한 양/W0
 * 폭만 맞추면 안 된다. **중심 이동(C)이 끝 방향을 결정한다.**
 */
// ⚠️ 끝 구간을 직선으로 두면 **각진 면**이 생긴다. 무늬가 없는 면(뒤통수)에서 특히 눈에 띈다.
//    끝 근처는 W ∝ sqrt(1-f) 가 되도록 점을 촘촘히 넣어 둥글게 마감한다.
const PROF_F = [0.000, 0.295, 0.593, 0.738, 0.858, 0.928, 0.955, 0.975, 0.990, 0.997, 1.000];
const PROF_W = [1.000, 0.888, 0.763, 0.586, 0.379, 0.237, 0.197, 0.153, 0.088, 0.048, 0.000];
const PROF_C = [0.000, 0.055, 0.100, 0.120, 0.135, 0.135, 0.135, 0.135, 0.135, 0.135, 0.135];
function lut(f, arr) {
  if (f <= 0) return arr[0];
  if (f >= 1) return arr[arr.length - 1];
  let i = 1;
  while (i < PROF_F.length - 1 && PROF_F[i] < f) i++;
  const t0 = PROF_F[i - 1], t1 = PROF_F[i];
  return arr[i - 1] + ((f - t0) / (t1 - t0)) * (arr[i] - arr[i - 1]);
}

/**
 * ── 귀 단면의 **띠 구조**를 뽑는다:  바깥선 / 크림 / 귓속(어두움) / 크림 / 안쪽선
 * ⚠️ 단면을 통째로 균등하게 눌러 올리면 **귓속 어두운 부분이 끝까지 따라 올라가** 부자연스럽다.
 *    원화 실측(너굴 왼쪽 귀): 귓속 폭이 y24 에서 97px → y0 에서 43px 로 줄고,
 *    그 기울기로 외삽하면 **절단면 위 19px 에서 닫힌다.** 즉 귀 끝은 크림과 윤곽선만 남는다.
 *    그래서 띠마다 **제 궤적**을 주어야 한다. 폭 하나로는 절대 안 맞는다.
 */
function bandsAt(y, L, R) {
  const lum = x => { const o = (y * W + x) * 4; return src[o + 3] <= 32 ? null : 0.3 * src[o] + 0.6 * src[o + 1] + 0.1 * src[o + 2]; };
  let mx = 0;
  for (let x = L; x <= R; x++) { const v = lum(x); if (v != null && v > mx) mx = v; }
  const th = mx * 0.78;
  const seg = []; let cur = null;
  for (let x = L; x <= R; x++) {
    const v = lum(x), br = v != null && v >= th;
    if (!cur || cur.b !== br) { if (cur) seg.push(cur); cur = { b: br, s: x, e: x }; } else cur.e = x;
  }
  if (cur) seg.push(cur);
  const m = [];                       // 6px 미만 조각은 이웃에 흡수 (안티에일리어싱 잡음)
  for (const g of seg) {
    if (m.length && (g.e - g.s + 1) < 6) m[m.length - 1].e = g.e;
    else if (m.length && m[m.length - 1].b === g.b) m[m.length - 1].e = g.e;
    else m.push({ ...g });
  }
  return m;
}
/** 귓속(양끝이 아닌 가장 넓은 어두운 띠)을 아래로 추적해 중심·반폭의 기울기를 잰다 */
function bowlTrack(t) {
  const rec = [];
  let prevC = null;
  for (const R of t.rows) {
    if (R.y > 26) break;
    const m = bandsAt(R.y, R.l, R.r);
    let best = null;
    for (let i = 1; i < m.length - 1; i++) {
      if (m[i].b) continue;
      const w = m[i].e - m[i].s + 1;
      if (!best || w > best.w) best = { w, c: (m[i].s + m[i].e) / 2, s: m[i].s, e: m[i].e };
    }
    if (!best) break;
    if (prevC != null && Math.abs(best.c - prevC) > 25) break;
    prevC = best.c;
    rec.push({ y: R.y, c: best.c, h: best.w / 2, m });
  }
  if (rec.length < 5) return null;
  const fit = (key) => {              // 최소제곱 1차
    let n = 0, sy = 0, sv = 0, syy = 0, syv = 0;
    for (const r of rec) { n++; sy += r.y; sv += r[key]; syy += r.y * r.y; syv += r.y * r[key]; }
    const d = n * syy - sy * sy;
    return d === 0 ? 0 : (n * syv - sy * sv) / d;
  };
  const m0 = rec[0].m;
  if (m0.length !== 5 || m0[0].b || m0[2].b || m0[4].b) return null;   // D B D B D 아니면 포기
  return {
    c0: rec[0].c, h0: rec[0].h, dc: fit('c'), dh: fit('h'),
    S: [m0[0].s, m0[1].s, m0[2].s, m0[3].s, m0[4].s, m0[4].e + 1],
    wOutL: m0[0].e - m0[0].s + 1, wOutR: m0[4].e - m0[4].s + 1,
    closeK: rec[0].h / Math.max(1e-6, fit('h')),
  };
}

const T = ears.map(track);
// ⚠️ 뒤통수처럼 **귓속 구조가 없는 매끈한 면**에서는 띠 모델이 오히려 해롭다.
//    닫혀가는 띠 경계가 대각선 주름으로 보인다. 그런 그림은 --noband 로 끈다.
for (const t of T) t.band = arg('noband') ? null : bowlTrack(t);
T.forEach((t, i) => console.log(
  `  귀${i + 1} 띠: ${t.band ? `귓속 반폭 ${t.band.h0.toFixed(0)}px, 기울기 ${t.band.dh.toFixed(2)}/행 → 절단면 위 ${t.band.closeK.toFixed(1)}px 에서 닫힘` : '검출 실패 → 균등 축소로 대체'}`));
T.forEach((t, i) => console.log(
  `  귀${i + 1}: 중심 x=${t.C0.toFixed(1)} W0=${t.W0} → 타원 a=${t.a.toFixed(1)} b=${t.b.toFixed(1)} c=${t.c.toFixed(1)}  끝높이 K=${t.K.toFixed(1)}`));
const K = Math.ceil(Math.max(...T.map(t => t.K)));   // 두 귀 중 큰 쪽에 맞춰 캔버스를 늘린다

const NH = H + K;
const out = Buffer.alloc(W * NH * 4);
// 원본은 K 만큼 아래로 그대로 옮긴다 (한 픽셀도 건드리지 않는다)
src.copy(out, K * W * 4, 0, W * H * 4);

// 결정적 잡음 — 털끝처럼 가장자리를 아주 조금 들쭉날쭉하게 (Math.random 금지: 재현 불가)
let rs_ = SEED;
const rnd = () => ((rs_ = (rs_ * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const noise = new Float32Array(K * 2);
for (let i = 0; i < noise.length; i++) noise[i] = (rnd() - 0.5) * 2;
const smoothNoise = (i) => {           // 3점 평활 → 잡티가 아니라 털결처럼 보이게
  const j = Math.max(1, Math.min(noise.length - 2, i));
  return (noise[j - 1] + noise[j] * 2 + noise[j + 1]) / 4;
};

for (const [ei, t] of T.entries()) {
  for (let k = 1; k <= Math.floor(t.K); k++) {
    const f = k / t.K;
    // 행의 **위쪽 모서리**에서 잰다. 행 중심에서 재면 맨 윗행이 넓게 남아 뭉툭해진다.
    // 폭은 행 **아래쪽 모서리**에서 잰다. (k+0.5)로 재면 이음선 첫 행이 2px 좁아져 턱이 진다.
    const ff = Math.max(0, Math.min(1, (k - 0.5) / t.K));
    const wt = t.W0 * lut(ff, PROF_W);
    if (wt < 2) continue;
    // 중심은 **바깥쪽으로** 이동한다 (원화 실측). 이게 끝 방향을 만든다.
    const dir = t.outerIsLeft ? -1 : 1;
    const ct = t.C0 + dir * t.W0 * lut(ff, PROF_C);
    // 끝에서는 흔들지 않는다 — 폭이 좁아 잡티가 검은 점으로 남는다(실측)
    const jitter = smoothNoise(ei * 200 + k) * 1.2 * Math.max(0, 1 - ff * 1.4);
    const tL = ct - wt / 2 + jitter, tR = ct + wt / 2 + jitter;

    // 아래쪽 단면 중 어디를 가져올지: 위로 갈수록 더 아래 단면을 눌러 담는다.
    // ⚠️ 정수 행으로 고르면 한 행이 여러 출력 행에 반복돼 **가로 줄무늬**가 생긴다(실측).
    //    세로도 보간할 것.
    const sf = Math.min(t.rows.length - 1.001, SKIP + f * DEPTH);
    const i0 = Math.floor(sf), i1 = Math.min(t.rows.length - 1, i0 + 1), gy = sf - i0;
    const R0 = t.rows[i0], R1 = t.rows[i1];

    // ── 목표 매듭: [바깥끝, 윤곽선끝, 귓속시작, 귓속끝, 안쪽띠시작, 안쪽끝]
    //    윤곽선은 굵기를 유지하고, 안쪽 어두운 띠는 폭에 비례하며,
    //    **귓속은 제 기울기대로 좁아져 닫힌다.**
    let TK = null;
    if (t.band) {
      const B = t.band, sc = wt / t.W0;
      const bc = B.c0 - B.dc * k;                       // 위로 갈수록 (아래 기울기의 반대)
      const bh = Math.max(0, B.h0 - B.dh * k);
      const woL = t.outerIsLeft ? B.wOutL : B.wOutL * sc;
      const woR = t.outerIsLeft ? B.wOutR * sc : B.wOutR;
      let k1 = tL + woL, k4 = tR - woR;
      if (k4 - k1 < 4) { k1 = tL + (wt - 4) * 0.3; k4 = tR - (wt - 4) * 0.3; }
      let k2 = Math.max(k1 + 0.5, Math.min(k4 - 0.5, bc - bh));
      let k3 = Math.max(k2, Math.min(k4 - 0.5, bc + bh));
      TK = [tL, k1, k2, k3, k4, tR];
    }

    const y = K - k;
    for (let x = Math.floor(tL) - 2; x <= Math.ceil(tR) + 2; x++) {
      if (x < 0 || x >= W) continue;
      const d = Math.min(x - tL, tR - x);
      const cov = Math.max(0, Math.min(1, (d + 1.0) / 1.6));
      if (cov <= 0) continue;
      // ⚠️ 단면을 통째로 균등하게 누르면 **바깥 윤곽선까지 같이 눌려 사라진다.**
      //    끝으로 갈수록 선이 없어져 매끈한 플라스틱 덩어리처럼 보인다(실측 실패).
      //    가장자리 RIM px 는 폭을 유지하고 **안쪽만** 눌러 담아 선 굵기를 지킨다.
      const rimT = Math.min(RIM, Math.max(0, (wt - 4) / 3));
      let r = 0, g2 = 0, b2 = 0, al = 0;
      for (const [R, wgt] of [[R0, 1 - gy], [R1, gy]]) {
        if (wgt <= 0) continue;
        const ws = R.r - R.l;
        const dL = x - tL, dR = tR - x;
        let fx, bandLo = R.l, bandHi = R.r;
        if (TK) {
          // ── 띠 기반 워프: 목표 매듭 6개 ↔ 원본 매듭 6개를 구간별 선형으로 잇는다
          let i = 1; while (i < 5 && TK[i] <= x) i++;
          const a0 = TK[i - 1], a1 = TK[i], b0 = t.band.S[i - 1], b1 = t.band.S[i];
          fx = a1 - a0 < 1e-6 ? b0 : b0 + ((x - a0) / (a1 - a0)) * (b1 - b0);
          bandLo = b0; bandHi = b1;
        } else if (rimT > 0.5 && dL < rimT) fx = R.l + (dL / rimT) * RIM;
        else if (rimT > 0.5 && dR < rimT) fx = R.r - (dR / rimT) * RIM;
        else if (rimT > 0.5) {
          const uu = (dL - rimT) / Math.max(1e-6, wt - 2 * rimT);
          fx = (R.l + RIM) + uu * Math.max(1, ws - 2 * RIM);
        } else fx = R.l + ((x - tL) / (tR - tL)) * ws;
        // ⚠️ 단면을 그대로 위로 밀면 원본의 미세한 명암이 **세로 줄무늬**로 남는다.
        //    원화의 귀 끝은 톤이 뭉개진 매끈한 덩어리다(실측). 끝으로 갈수록 흐리게 한다.
        //    단, 흐림은 **그 띠 안에서만** — 띠를 넘으면 윤곽선이 번진다.
        // ⚠️ 탭 수를 고정하면 반경이 커질 때 **계단(에일리어싱)** 이 생겨 대각선 주름으로 보인다.
        //    반경에 비례해 탭을 늘린다.
        const rad = SMOOTH * ff * ff;
        const NT = Math.max(2, Math.min(12, Math.round(rad / 3)));
        let sr = 0, sg = 0, sb = 0, sa = 0, sw = 0;
        for (let ti = -NT; ti <= NT; ti++) {
          const px = Math.max(bandLo, Math.min(bandHi, fx + (ti * rad) / NT));
          const x0 = Math.max(0, Math.min(W - 1, Math.floor(px))), x1 = Math.min(W - 1, x0 + 1);
          const gx = px - x0, tw = 1 - Math.abs(ti) / (NT + 1);
          const o0 = (R.y * W + x0) * 4, o1 = (R.y * W + x1) * 4;
          sr += tw * (src[o0] * (1 - gx) + src[o1] * gx);
          sg += tw * (src[o0 + 1] * (1 - gx) + src[o1 + 1] * gx);
          sb += tw * (src[o0 + 2] * (1 - gx) + src[o1 + 2] * gx);
          sa += tw * (src[o0 + 3] * (1 - gx) + src[o1 + 3] * gx);
          sw += tw;
        }
        r += wgt * (sr / sw); g2 += wgt * (sg / sw); b2 += wgt * (sb / sw); al += wgt * (sa / sw);
      }
      const aa = cov * (al / 255);
      if (aa <= 0.004) continue;
      const to = (y * W + x) * 4;
      out[to] = out[to] * (1 - aa) + r * aa;
      out[to + 1] = out[to + 1] * (1 - aa) + g2 * aa;
      out[to + 2] = out[to + 2] * (1 - aa) + b2 * aa;
      out[to + 3] = Math.max(out[to + 3], Math.round(aa * 255));
    }
  }
}

// ── 내부 후처리: 띠 경계에서 생기는 **대각선 주름**을 푼다
// ⚠️ 귓속이 닫히고 나면 크림 띠 두 개가 맞닿는데, 원본에서 두 띠의 톤이 달라
//    **끝으로 수렴하는 주름**으로 보인다(실측). 재구성 구간 안쪽만 가로로 흐려 없앤다.
//    윤곽선은 건드리면 안 되므로 **알파 경계에서 EDGE px 안쪽만** 대상으로 한다.
{
  const POST = +(arg('post') || 22), EDGE = 6;
  const topK = Math.ceil(Math.max(...T.map(t => t.K)));
  const al = (x, y) => (x < 0 || y < 0 || x >= W || y >= NH ? 0 : out[(y * W + x) * 4 + 3]);
  const inner = (x, y) => {            // 알파 경계에서 EDGE 이상 안쪽인가
    for (let dy = -EDGE; dy <= EDGE; dy++) for (let dx = -EDGE; dx <= EDGE; dx++)
      if (al(x + dx, y + dy) <= 32) return false;
    return true;
  };
  const cp = Buffer.from(out);
  for (let y = 0; y < topK; y++) {
    const ff = Math.max(0, Math.min(1, (topK - y) / topK));
    const rad = Math.round(POST * Math.pow(ff, 1.5));
    if (rad < 1) continue;
    for (let x = 0; x < W; x++) {
      if (al(x, y) <= 32 || !inner(x, y)) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dx = -rad; dx <= rad; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        if (!inner(xx, y)) continue;
        const o = (y * W + xx) * 4;
        const w2 = 1 - Math.abs(dx) / (rad + 1);
        r += w2 * cp[o]; g += w2 * cp[o + 1]; b += w2 * cp[o + 2]; n += w2;
      }
      if (n <= 0) continue;
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
}

// ── 실루엣 경계에 윤곽선을 둘러 마감한다
// ⚠️ 이게 없으면 **끝이 이상해 보인다.** 타원은 apex 근처에서 폭이 sqrt 로 급감해
//    정수 행으로 래스터화하면 마지막 행이 30px 폭으로 뚝 끊긴다. 그 위쪽 경계에는
//    선이 없어 크림색 단면이 배경에 그대로 노출된다(실측: 5배 확대에서 명확).
//    원화는 귀 둘레에 갈색 윤곽 띠가 돌아가므로, 같은 색으로 경계를 둘러야 마감이 된다.
{
  // 윤곽 색: 원본 귀의 바깥쪽 끝 몇 픽셀 평균 (near-black 이 아니라 중간 갈색이다)
  let cr = 0, cg = 0, cb = 0, cn = 0;
  for (const t of T) {
    for (const R of t.rows.slice(0, 12)) {
      for (let i = 0; i < 5; i++) {
        const o = (R.y * W + R.l + i) * 4;
        if (src[o + 3] > 32) { cr += src[o]; cg += src[o + 1]; cb += src[o + 2]; cn++; }
      }
    }
  }
  const OC = cn ? [cr / cn, cg / cn, cb / cn] : [120, 98, 85];
  const RAD = +(arg('stroke') || 5);
  const topK = Math.ceil(Math.max(...T.map(t => t.K)));
  const FADE = +(arg('strokefade') || 12);   // 이음선 쪽으로 서서히 뺀다
  const al = (x, y) => (x < 0 || y < 0 || x >= W || y >= NH ? 0 : out[(y * W + x) * 4 + 3]);
  const patch = [];
  for (let y = 0; y < topK + 2; y++) for (let x = 0; x < W; x++) {
    if (al(x, y) <= 32) continue;
    let d = 99;
    for (let dy = -RAD; dy <= RAD && d > 1; dy++) for (let dx = -RAD; dx <= RAD; dx++) {
      if (al(x + dx, y + dy) > 32) continue;
      const dd = Math.hypot(dx, dy);
      if (dd < d) d = dd;
    }
    if (d > RAD) continue;
    // ⚠️ 이음선까지 선을 그으면 **원본 구간만 갑자기 진해져 턱이 진다.**
    //    끝 쪽에만 필요하므로 이음선 근처에서 0 으로 뺀다.
    const fade = Math.max(0, Math.min(1, (topK - y) / FADE));
    const w = Math.max(0, Math.min(1, 1 - (d - 1) / (RAD - 1))) * 0.92 * fade;
    if (w > 0.01) patch.push([x, y, w]);
  }
  for (const [x, y, w] of patch) {
    const o = (y * W + x) * 4;
    out[o] = out[o] * (1 - w) + OC[0] * w;
    out[o + 1] = out[o + 1] * (1 - w) + OC[1] * w;
    out[o + 2] = out[o + 2] * (1 - w) + OC[2] * w;
  }
  console.log(`  윤곽선 마감 ${patch.length}px  색 rgb(${OC.map(v => Math.round(v)).join(',')})`);
}

execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', `${W}x${NH}`, '-i', 'pipe:0', '-frames:v', '1', OUT], { input: out });
console.log(`✓ ${OUT.split('/').pop()}  ${W}x${H} → ${W}x${NH}  (귀 +${K}px)`);
