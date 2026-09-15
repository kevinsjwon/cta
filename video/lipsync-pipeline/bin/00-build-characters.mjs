#!/usr/bin/env node
/**
 * 00-build-characters — 캐릭터 에셋 생성기 (SVG 작도 → 알파 PNG)
 *
 * 모든 레이어가 **같은 viewBox** 를 쓴다. 따라서 같은 픽셀 크기로 래스터화해
 * 순서대로 알파 합성하면 정확히 겹친다. 앵커 좌표 계산이 필요 없다.
 *
 * 레이어 구성 (캐릭터당):
 *   front_body.svg     몸+머리+눈흰자 등 (눈동자·입 제외)
 *   front_eyes_open.svg / front_eyes_closed.svg
 *   front_mouth_<KEY>.svg   × 9   (A E EO O U I M X R)
 *   back.svg           뒷모습 (얼굴 요소 없음)
 *
 * 출력: input/characters/<id>/*.svg + *.png (PNG는 전달·확인용, 렌더러는 SVG 직접 사용)
 */
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = join(ROOT, 'input', 'characters');

const VB = { w: 400, h: 480 };            // 모든 레이어 공통 좌표계
const PNG_W = 800;                         // 출력 PNG 폭 (2x)

// 입 모양 9종 → (열림 0~1, 폭배율). 02단계가 내보내는 키와 정확히 일치해야 한다.
export const MOUTH_PARAMS = {
  A:  { open: 1.00, wide: 1.00 },
  E:  { open: 0.42, wide: 1.18 },
  EO: { open: 0.68, wide: 0.86 },
  O:  { open: 0.78, wide: 0.70 },
  U:  { open: 0.50, wide: 0.55 },
  I:  { open: 0.22, wide: 1.10 },
  M:  { open: 0.00, wide: 0.90 },
  X:  { open: 0.10, wide: 0.78 },
  R:  { open: 0.06, wide: 0.72 },
};

const svg = inner =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${VB.w}" height="${VB.h}" viewBox="0 0 ${VB.w} ${VB.h}">${inner}</svg>`;

// ════════════════════════════════════════════════════════════════════
// 펭귄 — 답변자 / AI 전문가 / 침착·정확하지만 아주 쉽게
//   동글동글한 계란형 몸, 큰 눈, 둥근 안경(전문가 기호), 발랄한 날개
// ════════════════════════════════════════════════════════════════════
const PENGUIN = {
  id: 'P',
  label: 'penguin',
  navy: '#33436B', navyDark: '#26325180', belly: '#FFF6E8',
  beak: '#FFA83E', beakDark: '#E8892A', foot: '#FFA83E',
  blush: '#FF9BB0', eyeW: '#FFFFFF', pupil: '#2A2F45',
  glass: '#5B6B8C',
  eyeCX: 42, eyeCY: 176, eyeR: 30,
  mouthCX: 200, mouthCY: 232,
};

function penguinBody() {
  const P = PENGUIN;
  return svg(`
    <!-- 날개: 살짝 벌어져 발랄하게 -->
    <ellipse cx="86"  cy="312" rx="24" ry="62" fill="${P.navy}" transform="rotate(-24 86 312)"/>
    <ellipse cx="314" cy="312" rx="24" ry="62" fill="${P.navy}" transform="rotate(24 314 312)"/>
    <!-- 발 -->
    <ellipse cx="152" cy="438" rx="40" ry="20" fill="${P.foot}"/>
    <ellipse cx="248" cy="438" rx="40" ry="20" fill="${P.foot}"/>
    <!-- 몸: 계란형(위가 좁고 아래가 둥근) -->
    <path d="M200 46 C288 46 326 146 326 254 C326 372 272 434 200 434
             C128 434 74 372 74 254 C74 146 112 46 200 46 Z" fill="${P.navy}"/>
    <!-- 배: 크림색 -->
    <ellipse cx="200" cy="296" rx="94" ry="126" fill="${P.belly}"/>
    <!-- 얼굴 흰 영역 (눈 주위까지 크림색을 끌어올려 얼굴이 읽히게) -->
    <path d="M200 128 C258 128 292 172 292 214 C292 252 252 272 200 272
             C148 272 108 252 108 214 C108 172 142 128 200 128 Z" fill="${P.belly}"/>
    <!-- 볼 블러시 -->
    <ellipse cx="118" cy="226" rx="20" ry="13" fill="${P.blush}" opacity="0.55"/>
    <ellipse cx="282" cy="226" rx="20" ry="13" fill="${P.blush}" opacity="0.55"/>
    <!-- 둥근 안경: 전문가 기호. 눈 위에 얹히므로 눈 레이어보다 아래 -->
    <g fill="none" stroke="${P.glass}" stroke-width="6" opacity="0.9">
      <circle cx="${200 - P.eyeCX}" cy="${P.eyeCY}" r="${P.eyeR + 6}"/>
      <circle cx="${200 + P.eyeCX}" cy="${P.eyeCY}" r="${P.eyeR + 6}"/>
      <path d="M${200 - P.eyeCX + P.eyeR + 6} ${P.eyeCY} L${200 + P.eyeCX - P.eyeR - 6} ${P.eyeCY}"/>
      <path d="M${200 - P.eyeCX - P.eyeR - 6} ${P.eyeCY - 2} L142 ${P.eyeCY - 14}"/>
      <path d="M${200 + P.eyeCX + P.eyeR + 6} ${P.eyeCY - 2} L258 ${P.eyeCY - 14}"/>
    </g>
    <!-- 눈 흰자 -->
    <circle cx="${200 - P.eyeCX}" cy="${P.eyeCY}" r="${P.eyeR}" fill="${P.eyeW}"/>
    <circle cx="${200 + P.eyeCX}" cy="${P.eyeCY}" r="${P.eyeR}" fill="${P.eyeW}"/>
  `);
}
function penguinEyes(open) {
  const P = PENGUIN;
  if (!open) {
    return svg([-1, 1].map(s => `
      <path d="M${200 + s * P.eyeCX - 22} ${P.eyeCY} q22 14 44 0"
            stroke="${P.pupil}" stroke-width="6" fill="none" stroke-linecap="round"/>`).join(''));
  }
  return svg([-1, 1].map(s => {
    const cx = 200 + s * P.eyeCX;
    return `
      <circle cx="${cx}" cy="${P.eyeCY + 3}" r="17" fill="${P.pupil}"/>
      <circle cx="${cx - 6}" cy="${P.eyeCY - 5}" r="6.5" fill="#FFFFFF" opacity="0.95"/>
      <circle cx="${cx + 7}" cy="${P.eyeCY + 9}" r="3" fill="#FFFFFF" opacity="0.6"/>`;
  }).join(''));
}
/** 펭귄 입 = 부리. 위/아래 부리가 벌어지는 각도로 표현 */
function penguinMouth(key) {
  const P = PENGUIN, { open, wide } = MOUTH_PARAMS[key];
  const cx = P.mouthCX, cy = P.mouthCY;
  const hw = 32 * wide;                  // 부리 반폭
  const gap = 34 * open;                 // 벌어짐 (A에서 확실히 크게)
  const upH = 15, loH = 13;
  return svg(`
    <!-- 입 안쪽: 둥근 타원 (각진 삼각형은 부자연스럽다) -->
    ${open > 0.08 ? `<ellipse cx="${cx}" cy="${cy + gap * 0.52}" rx="${hw * 0.82}"
        ry="${Math.max(3, gap * 0.62)}" fill="#8A3A46"/>
      <ellipse cx="${cx}" cy="${cy + gap * 0.78}" rx="${hw * 0.5}"
        ry="${Math.max(2, gap * 0.3)}" fill="#C25E6B" opacity="0.8"/>` : ''}
    <!-- 위 부리 -->
    <path d="M${cx - hw} ${cy} Q${cx} ${cy - upH * 1.5} ${cx + hw} ${cy}
             Q${cx} ${cy + 4} ${cx - hw} ${cy} Z" fill="${P.beak}"/>
    <!-- 아래 부리 -->
    <path d="M${cx - hw * 0.86} ${cy + gap} Q${cx} ${cy + gap + loH * 1.6} ${cx + hw * 0.86} ${cy + gap}
             Q${cx} ${cy + gap - 3} ${cx - hw * 0.86} ${cy + gap} Z" fill="${P.beakDark}"/>
  `);
}
function penguinBack() {
  const P = PENGUIN;
  return svg(`
    <ellipse cx="86"  cy="312" rx="24" ry="62" fill="${P.navy}" transform="rotate(-24 86 312)"/>
    <ellipse cx="314" cy="312" rx="24" ry="62" fill="${P.navy}" transform="rotate(24 314 312)"/>
    <ellipse cx="152" cy="438" rx="36" ry="18" fill="${P.beakDark}"/>
    <ellipse cx="248" cy="438" rx="36" ry="18" fill="${P.beakDark}"/>
    <path d="M200 46 C288 46 326 146 326 254 C326 372 272 434 200 434
             C128 434 74 372 74 254 C74 146 112 46 200 46 Z" fill="${P.navy}"/>
    <!-- 등 중앙 음영으로 구형감 -->
    <ellipse cx="200" cy="250" rx="70" ry="120" fill="#2A3757" opacity="0.55"/>
    <!-- 뒤에서 보이는 안경 다리 → 동일 캐릭터로 읽히게 -->
    <g stroke="${P.glass}" stroke-width="5" fill="none" opacity="0.75">
      <path d="M126 168 L104 182"/><path d="M274 168 L296 182"/>
    </g>
    <!-- 꼬리 -->
    <path d="M200 420 q-16 26 0 30 q16 -4 0 -30 Z" fill="#2A3757"/>
  `);
}

// ════════════════════════════════════════════════════════════════════
// 토끼 — 질문자 / 처음 듣는 아이 / 작고 발랄
//   머리 비중을 크게(아이 비율), 큰 눈, 벌어진 귀, 솜꼬리
// ════════════════════════════════════════════════════════════════════
const RABBIT = {
  id: 'R',
  label: 'rabbit',
  fur: '#FFF4EC', furShade: '#EFD9C9', inner: '#FFB6C8',
  nose: '#FF6E8A', blush: '#FFA3B8', pupil: '#3A3244', eyeW: '#FFFFFF',
  line: '#E2C4B2',                        // 크림색끼리 겹치면 형태가 안 읽힌다 → 외곽선 필수
  eyeCX: 46, eyeCY: 196, eyeR: 34,
  mouthCX: 200, mouthCY: 264,
};

function rabbitBody() {
  const R = RABBIT;
  return svg(`
    <g stroke="${R.line}" stroke-width="5">
      <!-- 귀: 살짝 벌어지고 한쪽이 더 기울어 호기심 -->
      <ellipse cx="146" cy="86" rx="27" ry="72" fill="${R.fur}" transform="rotate(-12 146 86)"/>
      <ellipse cx="256" cy="80" rx="27" ry="72" fill="${R.fur}" transform="rotate(16 256 80)"/>
      <!-- 팔 -->
      <ellipse cx="122" cy="386" rx="22" ry="34" fill="${R.fur}" transform="rotate(-18 122 386)"/>
      <ellipse cx="278" cy="386" rx="22" ry="34" fill="${R.fur}" transform="rotate(18 278 386)"/>
      <!-- 발 -->
      <ellipse cx="166" cy="452" rx="30" ry="17" fill="${R.furShade}"/>
      <ellipse cx="234" cy="452" rx="30" ry="17" fill="${R.furShade}"/>
      <!-- 몸: 작게 (아이 비율: 머리 > 몸) -->
      <ellipse cx="200" cy="392" rx="86" ry="74" fill="${R.fur}"/>
      <!-- 머리: 크고 둥글게 -->
      <circle cx="200" cy="212" r="118" fill="${R.fur}"/>
    </g>
    <!-- 귀 안쪽: 외곽선 없이 -->
    <ellipse cx="146" cy="92" rx="13" ry="52" fill="${R.inner}" transform="rotate(-12 146 92)"/>
    <ellipse cx="256" cy="86" rx="13" ry="52" fill="${R.inner}" transform="rotate(16 256 86)"/>
    <!-- 볼 블러시: 크게 -->
    <ellipse cx="110" cy="250" rx="28" ry="18" fill="${R.blush}" opacity="0.68"/>
    <ellipse cx="290" cy="250" rx="28" ry="18" fill="${R.blush}" opacity="0.68"/>
    <!-- 눈 흰자 -->
    <circle cx="${200 - R.eyeCX}" cy="${R.eyeCY}" r="${R.eyeR}" fill="${R.eyeW}"/>
    <circle cx="${200 + R.eyeCX}" cy="${R.eyeCY}" r="${R.eyeR}" fill="${R.eyeW}"/>
    <!-- 코: 크고 진하게 (작으면 크림색에 묻힌다) -->
    <path d="M200 236 q-18 0 -18 11 q0 12 18 19 q18 -7 18 -19 q0 -11 -18 -11 Z" fill="${R.nose}"/>
    <ellipse cx="193" cy="243" rx="5" ry="3.5" fill="#FFFFFF" opacity="0.5"/>
  `);
}
function rabbitEyes(open) {
  const R = RABBIT;
  if (!open) {
    return svg([-1, 1].map(s => `
      <path d="M${200 + s * R.eyeCX - 24} ${R.eyeCY} q24 16 48 0"
            stroke="${R.pupil}" stroke-width="7" fill="none" stroke-linecap="round"/>`).join(''));
  }
  return svg([-1, 1].map(s => {
    const cx = 200 + s * R.eyeCX;
    return `
      <circle cx="${cx}" cy="${R.eyeCY + 3}" r="23" fill="${R.pupil}"/>
      <circle cx="${cx - 8}" cy="${R.eyeCY - 7}" r="9" fill="#FFFFFF" opacity="0.97"/>
      <circle cx="${cx + 9}" cy="${R.eyeCY + 12}" r="4.5" fill="#FFFFFF" opacity="0.65"/>`;
  }).join(''));
}
/** 토끼 입: 닫히면 토끼 특유의 y자, 열리면 둥근 입 */
function rabbitMouth(key) {
  const R = RABBIT, { open, wide } = MOUTH_PARAMS[key];
  const cx = R.mouthCX, cy = R.mouthCY;
  const rx = 24 * wide, ry = 23 * open;
  const lip = `<path d="M${cx} ${cy - 10} L${cx} ${cy - 2}" stroke="${R.pupil}" stroke-width="4.5"
                 stroke-linecap="round" fill="none" opacity="0.85"/>`;
  if (open < 0.12) {
    // 닫힘: 토끼 특유의 w 형태
    return svg(`${lip}
      <path d="M${cx - 21} ${cy - 1} q10.5 13 21 0 q10.5 13 21 0" stroke="${R.pupil}"
            stroke-width="5" fill="none" stroke-linecap="round"/>`);
  }
  return svg(`${lip}
    <ellipse cx="${cx}" cy="${cy + ry * 0.5}" rx="${rx}" ry="${Math.max(4, ry)}" fill="#9A4452"/>
    <ellipse cx="${cx}" cy="${cy + ry * 0.5 + Math.max(3, ry * 0.44)}"
             rx="${rx * 0.6}" ry="${Math.max(2.5, ry * 0.44)}" fill="#FF9BAA" opacity="0.85"/>`);
}
function rabbitBack() {
  const R = RABBIT;
  return svg(`
    <g stroke="${R.line}" stroke-width="5">
      <!-- 귀 뒷면: 안쪽 분홍 없음 -->
      <ellipse cx="146" cy="86" rx="27" ry="72" fill="${R.furShade}" transform="rotate(-12 146 86)"/>
      <ellipse cx="256" cy="80" rx="27" ry="72" fill="${R.furShade}" transform="rotate(16 256 80)"/>
      <ellipse cx="122" cy="386" rx="22" ry="34" fill="${R.furShade}" transform="rotate(-18 122 386)"/>
      <ellipse cx="278" cy="386" rx="22" ry="34" fill="${R.furShade}" transform="rotate(18 278 386)"/>
      <ellipse cx="200" cy="392" rx="86" ry="74" fill="${R.fur}"/>
      <circle cx="200" cy="212" r="118" fill="${R.fur}"/>
    </g>
    <!-- 뒤통수 음영: 구형감 -->
    <circle cx="200" cy="204" r="92" fill="${R.furShade}" opacity="0.45"/>
    <!-- 솜꼬리: 뒷모습 식별 포인트 -->
    <circle cx="200" cy="426" r="32" fill="#FFFFFF" stroke="${R.line}" stroke-width="4"/>
    <circle cx="190" cy="416" r="13" fill="${R.fur}" opacity="0.85"/>
  `);
}

// ════════════════════════════════════════════════════════════════════
const CHARS = [
  { spec: PENGUIN, body: penguinBody, eyes: penguinEyes, mouth: penguinMouth, back: penguinBack },
  { spec: RABBIT, body: rabbitBody, eyes: rabbitEyes, mouth: rabbitMouth, back: rabbitBack },
];

const png = s => new Resvg(s, { fitTo: { mode: 'width', value: PNG_W } }).render().asPng();

for (const C of CHARS) {
  const dir = join(OUTDIR, C.spec.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const files = {
    front_body: C.body(),
    front_eyes_open: C.eyes(true),
    front_eyes_closed: C.eyes(false),
    back: C.back(),
  };
  for (const k of Object.keys(MOUTH_PARAMS)) files[`front_mouth_${k}`] = C.mouth(k);

  for (const [name, s] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.svg`), s);
    writeFileSync(join(dir, `${name}.png`), png(s));
  }
  // 렌더러가 읽는 메타
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    id: C.spec.id, label: C.spec.label, viewBox: VB,
    layers: { body: 'front_body', eyesOpen: 'front_eyes_open', eyesClosed: 'front_eyes_closed', back: 'back' },
    mouthKeys: Object.keys(MOUTH_PARAMS),
  }, null, 2));

  console.log(`${C.spec.label} (${C.spec.id}): ${Object.keys(files).length}레이어 → ${dir}`);
}

// 확인용 시트: 정면 + 뒷면 + 입모양 9종을 한 장에
for (const C of CHARS) {
  const cols = 6, cw = VB.w, chh = VB.h;
  const keys = Object.keys(MOUTH_PARAMS);
  const cells = [
    { label: 'front', svg: C.body() + C.eyes(true) + C.mouth('R') },
    { label: 'blink', svg: C.body() + C.eyes(false) + C.mouth('R') },
    { label: 'back', svg: C.back() },
    ...keys.map(k => ({ label: k, svg: C.body() + C.eyes(true) + C.mouth(k) })),
  ];
  const rows = Math.ceil(cells.length / cols);
  const inner = cells.map((c, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * chh;
    const body = c.svg.replace(/<\/?svg[^>]*>/g, '');
    return `<g transform="translate(${x},${y})">
      <rect width="${cw}" height="${chh}" fill="${i % 2 ? '#EFEAE4' : '#F7F3EE'}"/>
      ${body}
      <text x="12" y="${chh - 14}" font-family="sans-serif" font-size="26" fill="#8A8078">${c.label}</text>
    </g>`;
  }).join('');
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cw}" height="${rows * chh}" viewBox="0 0 ${cols * cw} ${rows * chh}">${inner}</svg>`;
  const p = join(OUTDIR, `${C.spec.id}_sheet.png`);
  writeFileSync(p, new Resvg(sheet, { fitTo: { mode: 'width', value: 1800 } }).render().asPng());
  console.log(`  시트: ${p}`);
}
