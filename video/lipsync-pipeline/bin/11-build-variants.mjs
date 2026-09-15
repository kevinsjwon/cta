#!/usr/bin/env node
/**
 * 11-build-variants — 완성된 장면 이미지에 **입·눈만 이식**해 변형 프레임을 만든다
 *
 * 왜 이 방식인가:
 *   클로즈업 컷아웃은 머리 위·몸 아래가 잘려 있어, 그걸 쓰면 잘린 단면을 띠나 책상으로
 *   가려야 하고 화면이 답답해진다. 반면 제공된 **대화장면 이미지**는 캐릭터가 온전하고
 *   배경·책상·오버더숄더 구도까지 이미 들어 있다. 그걸 베이스로 쓰고 **입 영역과
 *   눈 영역만** 컷아웃에서 떼어 이식하면 모든 문제가 한 번에 사라진다.
 *
 * 얼굴 전체를 겹치면 두 그림의 비율 차이로 이목구비가 이중으로 보이지만,
 * 입·눈처럼 **좁은 영역**은 이식해도 티가 나지 않는다(실측 확인).
 *
 * 정렬은 동공 두 개로: 간격 비 = 배율, 중점 = 기준점.
 * 이식 영역 가장자리는 페더로 녹인다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');

const dim = f => execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0:s=x', f], { encoding: 'utf8' }).trim().split('x').map(Number);
const readRGB = (f, w, h) => Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', f,
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: w * h * 3 + 8192 }));
const readRGBA = (f, w, h) => Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', f,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: w * h * 4 + 8192 }));
const writeRGB = (buf, w, h, out) => execFileSync(FFMPEG, ['-y', '-v', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', out], { input: buf });

/**
 * 컷아웃의 한 영역을 장면 이미지에 이식.
 *
 * ⚠️ **대상 픽셀을 순회하며 소스를 역방향으로 샘플링**해야 한다.
 *    소스를 순회하며 대상에 쓰면, 축소 매핑(배율<1)에서 대상 픽셀 일부가
 *    아무것도 못 받아 **구멍이 생기고 체커 무늬처럼 보인다**(실측).
 *    샘플링은 이중선형으로 해야 축소 시 계단이 안 생긴다.
 */
function graft(base, SW, SH, cutFile, CW, CH, box, feather, tf, mask) {
  const cut = readRGBA(cutFile, CW, CH);
  const [x0, y0, x1, y1] = box;
  const fwd = (x, y) => [(x - tf.cmx) * tf.s + tf.smx, (y - tf.cmy) * tf.s + tf.smy];
  const inv = (X, Y) => [(X - tf.smx) / tf.s + tf.cmx, (Y - tf.smy) / tf.s + tf.cmy];
  const [dx0, dy0] = fwd(x0, y0), [dx1, dy1] = fwd(x1, y1);
  const DX0 = Math.max(0, Math.floor(Math.min(dx0, dx1)));
  const DX1 = Math.min(SW - 1, Math.ceil(Math.max(dx0, dx1)));
  const DY0 = Math.max(0, Math.floor(Math.min(dy0, dy1)));
  const DY1 = Math.min(SH - 1, Math.ceil(Math.max(dy0, dy1)));

  for (let Y = DY0; Y <= DY1; Y++) {
    for (let X = DX0; X <= DX1; X++) {
      const [cxf, cyf] = inv(X, Y);
      if (cxf < x0 || cxf > x1 || cyf < y0 || cyf > y1) continue;
      const fx = Math.min(1, Math.min(cxf - x0, x1 - cxf) / feather);
      const fy = Math.min(1, Math.min(cyf - y0, y1 - cyf) / feather);
      let w = fx * fy;
      // ⚠️ 박스 전체를 갈아끼우면 안 된다. 박스 안의 볼터치·털처럼 **안 움직여야 할 것까지**
      // 다른 그림의 것으로 바뀌어, 입이 열릴 때 주변 모양이 같이 변한다(실측).
      // 두 컷아웃이 **실제로 다른 픽셀**만 골라 이식한다.
      if (mask) w *= mask[Math.round(cyf) * CW + Math.round(cxf)] / 255;
      if (w <= 0.004) continue;

      // 이중선형 샘플
      const ix = Math.floor(cxf), iy = Math.floor(cyf);
      const tx = cxf - ix, ty = cyf - iy;
      const px = (xx, yy) => ((Math.min(CH - 1, Math.max(0, yy)) * CW) + Math.min(CW - 1, Math.max(0, xx))) * 4;
      const p00 = px(ix, iy), p10 = px(ix + 1, iy), p01 = px(ix, iy + 1), p11 = px(ix + 1, iy + 1);
      const bl = o => cut[p00 + o] * (1 - tx) * (1 - ty) + cut[p10 + o] * tx * (1 - ty)
        + cut[p01 + o] * (1 - tx) * ty + cut[p11 + o] * tx * ty;
      // ⚠️ 알파는 박스 안에서 **이진 처리**한다. 컷아웃의 반투명 가장자리를 그대로
      // 섞으면 장면 이미지가 비쳐 눈 주위에 회색 번짐이 생긴다(실측).
      // 박스 가장자리 페더는 w 가 따로 담당하므로 이음새는 여전히 부드럽다.
      const a = bl(3) >= 40 ? 1 : 0;   // 임계가 높으면 얼굴 픽셀이 걸러져 아래 그림이 비친다
      if (!a) continue;
      const m = w * a, g = 1 - m, to = (Y * SW + X) * 3;
      base[to] = base[to] * g + bl(0) * m;
      base[to + 1] = base[to + 1] * g + bl(1) * m;
      base[to + 2] = base[to + 2] * g + bl(2) * m;
    }
  }
}

const CHARS = {
  N: {
    scene: 'build/cu/scene_N.png',
    cutDir: 'build/cu/aligned',
    cutSize: [1407, 768],
    // 동공: 컷아웃 / 장면
    pupils: { cut: [512, 348, 898, 348], scene: [222, 705, 544, 705] },
    base: 'close_01_기본',
    mouth: { box: [460, 470, 950, 690], feather: 34, open: 'close_02_설명', diffTh: 78 },
    eyes: { box: [270, 130, 1140, 440], feather: 46, alt: { 경고: 'close_03_경고' } },
  },
  T: {
    scene: 'build/cu/scene_T.png',
    cutDir: 'build/cu/aligned',
    cutSize: [1380, 752],
    // ⚠️ 동공 자동검출은 이 그림체(단순한 점 눈)에서 신뢰할 수 없다.
    // 흰 머리 실루엣의 **폭 비율**로 배율을, **머리 꼭대기**로 기준점을 잡았다.
    // (세로 중심은 쓰면 안 된다 — 장면에서는 몸이 책상에 잘려 있다)
    // 격자를 얹어 눈 중심을 직접 읽어 잡았다. 자동 검출은 이 그림체에서 실패한다.
    // 검산: 눈 중점 기준 배율 0.841 로 입 중심이 (387,785) ≈ 실측 (384,785) 로 일치.
    pupils: { cut: [539, 542, 834, 542], scene: [260, 740, 508, 740] },
    base: 'tori_01_기본',
    mouth: { box: [580, 585, 900, 700], feather: 26, open: 'tori_01b_입벌림' },
    eyes: { box: [320, 395, 1050, 585], feather: 40, alt: { 놀람: 'tori_02_놀람' } },
  },
};

/**
 * 두 컷아웃의 **차이 마스크**를 만든다 (0~255).
 * 차이가 있는 픽셀만 1, 주변을 조금 넓힌 뒤 가장자리를 부드럽게 한다.
 * 이 마스크로 이식하면 변하는 부위 외에는 원본 장면이 그대로 남는다.
 */
function diffMask(fileA, fileB, CW, CH, box, grow, soften, DIFF_TH = 26) {
  const A = readRGBA(fileA, CW, CH), B = readRGBA(fileB, CW, CH);
  const [x0, y0, x1, y1] = box;
  const m = new Uint8Array(CW * CH);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const o = (y * CW + x) * 4;
    const d = Math.abs(A[o] - B[o]) + Math.abs(A[o + 1] - B[o + 1])
      + Math.abs(A[o + 2] - B[o + 2]) + Math.abs(A[o + 3] - B[o + 3]);
    if (d > DIFF_TH) m[y * CW + x] = 255;
  }
  // 팽창: 차이 주변을 조금 포함해야 이음새가 안 생긴다
  let cur = m;
  for (let r = 0; r < grow; r++) {
    const nxt = new Uint8Array(cur);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (cur[y * CW + x]) continue;
      if ((x > x0 && cur[y * CW + x - 1]) || (x < x1 && cur[y * CW + x + 1])
        || (y > y0 && cur[(y - 1) * CW + x]) || (y < y1 && cur[(y + 1) * CW + x])) nxt[y * CW + x] = 255;
    }
    cur = nxt;
  }
  // 가장자리 부드럽게 (박스 블러 반복)
  let f = Float32Array.from(cur);
  for (let p = 0; p < 2; p++) {
    const g = new Float32Array(f.length);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let sum = 0, n = 0;
      for (let dy = -soften; dy <= soften; dy++) for (let dx = -soften; dx <= soften; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        sum += f[ny * CW + nx]; n++;
      }
      g[y * CW + x] = sum / n;
    }
    f = g;
  }
  const out = new Uint8Array(CW * CH);
  let cnt = 0;
  for (let i = 0; i < f.length; i++) { out[i] = Math.round(f[i]); if (f[i] > 8) cnt++; }
  return { mask: out, count: cnt };
}

const OUT = join(ROOT, 'build', 'cu', 'variants');
mkdirSync(OUT, { recursive: true });

for (const [id, C] of Object.entries(CHARS)) {
  const [SW, SH] = dim(resolve(C.scene));
  const [CW, CH] = C.cutSize;
  const [cx1, cy1, cx2, cy2] = C.pupils.cut, [sx1, sy1, sx2, sy2] = C.pupils.scene;
  const tf = {
    s: Math.hypot(sx2 - sx1, sy2 - sy1) / Math.hypot(cx2 - cx1, cy2 - cy1),
    cmx: (cx1 + cx2) / 2, cmy: (cy1 + cy2) / 2,
    smx: (sx1 + sx2) / 2, smy: (sy1 + sy2) / 2,
  };
  console.log(`  ${id}: 장면 ${SW}x${SH}  배율 ${tf.s.toFixed(4)}`);

  // 실제로 변하는 픽셀만 담은 마스크를 미리 만든다
  const baseCut = join(ROOT, C.cutDir, `${C.base}.png`);
  const masks = { eyes: {}, mouth: null };
  {
    // ⚠️ 입 마스크는 임계를 높인다. 낮으면 두 컷아웃의 **주둥이 털 음영 차이**까지
    // 잡혀, 입이 열릴 때 주변 털에 얼룩이 생긴다(실측).
    const r = diffMask(baseCut, join(ROOT, C.cutDir, `${C.mouth.open}.png`), CW, CH,
      C.mouth.box, 4, 4, C.mouth.diffTh ?? 26);
    masks.mouth = r.mask;
    console.log(`     입 마스크 ${r.count}px`);
  }
  for (const [k, f] of Object.entries(C.eyes.alt)) {
    const r = diffMask(baseCut, join(ROOT, C.cutDir, `${f}.png`), CW, CH, C.eyes.box, 6, 3);
    masks.eyes[k] = r.mask;
    console.log(`     ${k} 눈 마스크 ${r.count}px`);
  }

  const exprs = ['기본', ...Object.keys(C.eyes.alt)];
  for (const e of exprs) {
    for (const mouth of ['closed', 'open']) {
      const buf = readRGB(resolve(C.scene), SW, SH);
      if (e !== '기본') {
        graft(buf, SW, SH, join(ROOT, C.cutDir, `${C.eyes.alt[e]}.png`), CW, CH,
          C.eyes.box, C.eyes.feather, tf, masks.eyes[e]);
      }
      if (mouth === 'open') {
        graft(buf, SW, SH, join(ROOT, C.cutDir, `${C.mouth.open}.png`), CW, CH,
          C.mouth.box, C.mouth.feather, tf, masks.mouth);
      }
      const f = join(OUT, `${id}_${e}_${mouth}.png`);
      writeRGB(buf, SW, SH, f);
      console.log(`     ${id}_${e}_${mouth}`);
    }
  }
}
console.log(`\n→ ${OUT}`);
