#!/usr/bin/env node
/**
 * 00b-build-backgrounds — 평면 2D 배경 생성기
 *
 * 입체감을 쓰지 않는다: 원근·그라디언트 음영·피사계심도 없음.
 * 색면(flat color) 과 실루엣만으로 구성한다.
 *
 * 두 갈래:
 *   dialogue_A / dialogue_B  같은 장소의 서로 다른 벽면. 팔레트를 공유해
 *                            컷이 바뀌어도 "같은 방"으로 읽히게 한다.
 *   narr_<n>                 나레이션 구간별 배경. 내용에 맞춰 전환.
 *
 * 9:16 과 16:9 를 각각 생성한다 (배경은 화면을 꽉 채워야 하므로 비율별로 필요).
 */
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'input', 'backgrounds');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 공통 팔레트 — 모든 배경이 이 색을 공유해야 한 세계로 읽힌다
const C = {
  wall: '#2C3350', wallDim: '#252B44', floor: '#1D2238',
  night: '#151A2E', win: '#3E4A78', star: '#8FA0D8',
  city: '#1A2039', cityLit: '#F2C879',
  paper: '#F4EDE2', ink: '#2C3350',
  up: '#4FC38A', down: '#E4685F', gold: '#F2C879', accent: '#7C8BC4',
};

const SIZES = { tall: [1080, 1920], wide: [1920, 1080] };

const wrap = (w, h, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;

/** 도시 야경 실루엣 (평면 색면) */
function skyline(w, baseY, h, fill, lit, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
  let out = '';
  let x = -40;
  while (x < w + 40) {
    const bw = 46 + rnd() * 70, bh = h * (0.34 + rnd() * 0.62);
    out += `<rect x="${x.toFixed(0)}" y="${(baseY - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${fill}"/>`;
    // 창문 불빛: 격자로 몇 개만
    for (let r = 0; r < Math.floor(bh / 46); r++) {
      for (let c = 0; c < Math.floor(bw / 34); c++) {
        if (rnd() > 0.62) {
          out += `<rect x="${(x + 12 + c * 34).toFixed(0)}" y="${(baseY - bh + 18 + r * 46).toFixed(0)}" width="13" height="17" fill="${lit}" opacity="0.85"/>`;
        }
      }
    }
    x += bw + 8 + rnd() * 16;
  }
  return out;
}

/** 꺾은선 차트 (평면, 두께만) */
function chart(x, y, w, h, pts, color, up) {
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(x + (i / (pts.length - 1)) * w).toFixed(1)} ${(y + h - p * h).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${Math.max(6, h * 0.035)}"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${(x + w).toFixed(1)}" cy="${(y + h - last * h).toFixed(1)}" r="${Math.max(9, h * 0.045)}" fill="${color}"/>
    ${up ? '' : `<path d="M${(x + w - h * 0.13).toFixed(1)} ${(y + h - last * h - h * 0.13).toFixed(1)}
        l${(h * 0.13).toFixed(1)} ${(h * 0.13).toFixed(1)} l${(h * 0.13).toFixed(1)} ${(-h * 0.13).toFixed(1)}"
        fill="none" stroke="${color}" stroke-width="${Math.max(5, h * 0.028)}" stroke-linecap="round"/>`}`;
}

// ════════════════════════════════════════════════════════════════════
// 대화용: 같은 방의 두 벽면. 팔레트·바닥선·창틀 두께를 공유한다.
// ════════════════════════════════════════════════════════════════════
function dialogueA(w, h) {                       // 창문 쪽 벽 (도시 야경)
  const floorY = h * 0.78;
  const wx = w * 0.10, wy = h * 0.16, ww = w * 0.80, wh = h * 0.46;
  return wrap(w, h, `
    <rect width="${w}" height="${h}" fill="${C.wall}"/>
    <rect y="${floorY}" width="${w}" height="${h - floorY}" fill="${C.floor}"/>
    <!-- 창 -->
    <rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="${C.night}"/>
    ${skyline(w, wy + wh, wh * 0.72, C.city, C.cityLit, 20260730)
      .split('<rect').map((s, i) => i === 0 ? s : '<rect' + s).join('')
      .replace(/<rect x="(-?\d+)"/g, (m, x) => `<rect x="${Math.max(+x, wx)}"`)}
    <rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="none" stroke="${C.accent}" stroke-width="${w * 0.012}"/>
    <rect x="${wx + ww / 2 - w * 0.006}" y="${wy}" width="${w * 0.012}" height="${wh}" fill="${C.accent}"/>
    <!-- 달 -->
    <circle cx="${wx + ww * 0.82}" cy="${wy + wh * 0.2}" r="${w * 0.035}" fill="${C.gold}" opacity="0.9"/>
    <!-- 바닥 걸레받이 -->
    <rect y="${floorY - h * 0.008}" width="${w}" height="${h * 0.008}" fill="${C.accent}" opacity="0.5"/>
  `);
}
function dialogueB(w, h) {                       // 반대쪽 벽 (차트가 걸린 벽)
  const floorY = h * 0.78;
  const bx = w * 0.12, by = h * 0.18, bw = w * 0.46, bh = h * 0.34;
  return wrap(w, h, `
    <rect width="${w}" height="${h}" fill="${C.wallDim}"/>
    <rect y="${floorY}" width="${w}" height="${h - floorY}" fill="${C.floor}"/>
    <!-- 벽에 걸린 차트 액자 -->
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${C.night}" stroke="${C.accent}" stroke-width="${w * 0.009}"/>
    ${chart(bx + bw * 0.12, by + bh * 0.18, bw * 0.76, bh * 0.62, [0.1, 0.2, 0.16, 0.38, 0.55, 0.5, 0.86], C.up, true)}
    <!-- 책장: 색면 막대만 -->
    <rect x="${w * 0.66}" y="${by}" width="${w * 0.24}" height="${bh * 1.24}" fill="${C.night}"/>
    ${[0, 1, 2].map(r => [0, 1, 2, 3, 4].map(c =>
      `<rect x="${w * 0.675 + c * w * 0.042}" y="${by + 14 + r * bh * 0.4}" width="${w * 0.03}" height="${bh * 0.3}"
             fill="${[C.gold, C.up, C.accent, C.paper, C.down][(r * 5 + c) % 5]}" opacity="0.75"/>`).join('')).join('')}
    <rect y="${floorY - h * 0.008}" width="${w}" height="${h * 0.008}" fill="${C.accent}" opacity="0.5"/>
  `);
}

// ════════════════════════════════════════════════════════════════════
// 나레이션용: 내용 구간별 배경
// ════════════════════════════════════════════════════════════════════
const NARR = {
  // 1) 시작 — 회사를 떠나는 밤
  intro: (w, h) => wrap(w, h, `
    <rect width="${w}" height="${h}" fill="${C.night}"/>
    ${skyline(w, h * 0.80, h * 0.42, C.city, C.cityLit, 7)}
    <rect y="${h * 0.80}" width="${w}" height="${h * 0.2}" fill="${C.floor}"/>
    <circle cx="${w * 0.78}" cy="${h * 0.18}" r="${w * 0.05}" fill="${C.gold}" opacity="0.92"/>
    ${[[0.14, 0.12], [0.3, 0.2], [0.55, 0.1], [0.9, 0.26]].map(([x, y]) =>
      `<circle cx="${w * x}" cy="${h * y}" r="${w * 0.005}" fill="${C.star}"/>`).join('')}
  `),
  // 2) 급등 — 우상향
  rise: (w, h) => wrap(w, h, `
    <rect width="${w}" height="${h}" fill="${C.wall}"/>
    ${[...Array(7)].map((_, i) => `<rect y="${h * (0.16 + i * 0.09)}" width="${w}" height="2" fill="${C.accent}" opacity="0.22"/>`).join('')}
    ${chart(w * 0.1, h * 0.2, w * 0.8, h * 0.5, [0.05, 0.12, 0.1, 0.3, 0.46, 0.62, 0.95], C.up, true)}
    <rect y="${h * 0.80}" width="${w}" height="${h * 0.2}" fill="${C.floor}"/>
  `),
  // 3) 레버리지 — 네 배
  leverage: (w, h) => wrap(w, h, `
    <rect width="${w}" height="${h}" fill="${C.wallDim}"/>
    ${[0, 1, 2, 3].map(i =>
      `<rect x="${w * (0.14 + i * 0.19)}" y="${h * (0.62 - i * 0.11)}" width="${w * 0.13}" height="${h * (0.14 + i * 0.11)}"
             fill="${C.gold}" opacity="${0.35 + i * 0.2}"/>`).join('')}
    <rect y="${h * 0.76}" width="${w}" height="${h * 0.24}" fill="${C.floor}"/>
  `),
  // 4) 급락 — 붉은 하락
  crash: (w, h) => wrap(w, h, `
    <rect width="${w}" height="${h}" fill="#3A2436"/>
    ${[...Array(7)].map((_, i) => `<rect y="${h * (0.16 + i * 0.09)}" width="${w}" height="2" fill="${C.down}" opacity="0.18"/>`).join('')}
    ${chart(w * 0.1, h * 0.2, w * 0.8, h * 0.5, [0.95, 0.9, 0.7, 0.44, 0.3, 0.16, 0.05], C.down, false)}
    <rect y="${h * 0.80}" width="${w}" height="${h * 0.2}" fill="#241827"/>
  `),
  // 5) 마진콜 — 전화/경보
  margincall: (w, h) => wrap(w, h, `
    <rect width="${w}" height="${h}" fill="#40252F"/>
    ${[0, 1, 2].map(i =>
      `<circle cx="${w * 0.5}" cy="${h * 0.42}" r="${w * (0.16 + i * 0.11)}" fill="none"
               stroke="${C.down}" stroke-width="${w * 0.011}" opacity="${0.5 - i * 0.14}"/>`).join('')}
    <rect x="${w * 0.5 - w * 0.075}" y="${h * 0.42 - w * 0.075}" width="${w * 0.15}" height="${w * 0.15}"
          rx="${w * 0.03}" fill="${C.down}"/>
    <rect y="${h * 0.80}" width="${w}" height="${h * 0.2}" fill="#291A21"/>
  `),
  // 6) 매각 — 좌에서 우로 넘어감
  sale: (w, h) => wrap(w, h, `
    <rect width="${w}" height="${h}" fill="${C.wall}"/>
    <rect x="${w * 0.06}" y="${h * 0.30}" width="${w * 0.30}" height="${h * 0.24}" fill="${C.night}" opacity="0.9"/>
    <rect x="${w * 0.64}" y="${h * 0.30}" width="${w * 0.30}" height="${h * 0.24}" fill="${C.gold}" opacity="0.85"/>
    <path d="M${w * 0.40} ${h * 0.42} L${w * 0.60} ${h * 0.42}" stroke="${C.paper}" stroke-width="${w * 0.016}" stroke-linecap="round"/>
    <path d="M${w * 0.555} ${h * 0.395} L${w * 0.60} ${h * 0.42} L${w * 0.555} ${h * 0.445}"
          fill="none" stroke="${C.paper}" stroke-width="${w * 0.016}" stroke-linecap="round" stroke-linejoin="round"/>
    <rect y="${h * 0.80}" width="${w}" height="${h * 0.2}" fill="${C.floor}"/>
  `),
  // 7) 결말 — 남은 것
  aftermath: (w, h) => wrap(w, h, `
    <rect width="${w}" height="${h}" fill="${C.wallDim}"/>
    <rect x="${w * 0.16}" y="${h * 0.28}" width="${w * 0.68}" height="${h * 0.10}" fill="${C.accent}" opacity="0.30"/>
    <rect x="${w * 0.16}" y="${h * 0.28}" width="${w * 0.15}" height="${h * 0.10}" fill="${C.gold}" opacity="0.9"/>
    ${[...Array(5)].map((_, i) => `<circle cx="${w * (0.2 + i * 0.15)}" cy="${h * 0.56}" r="${w * 0.012}" fill="${C.star}" opacity="0.5"/>`).join('')}
    <rect y="${h * 0.80}" width="${w}" height="${h * 0.2}" fill="${C.floor}"/>
  `),
};

// ════════════════════════════════════════════════════════════════════
const ALL = { dialogue_A: dialogueA, dialogue_B: dialogueB };
for (const [k, f] of Object.entries(NARR)) ALL[`narr_${k}`] = f;

for (const [name, fn] of Object.entries(ALL)) {
  for (const [tag, [w, h]] of Object.entries(SIZES)) {
    const s = fn(w, h);
    writeFileSync(join(OUT, `${name}.${tag}.svg`), s);
    writeFileSync(join(OUT, `${name}.${tag}.png`),
      new Resvg(s, { fitTo: { mode: 'width', value: w } }).render().asPng());
  }
  console.log(`  ${name}`);
}
console.log(`배경 ${Object.keys(ALL).length}종 × 2비율 → ${OUT}`);

// 확인용 시트 (9:16 축소 나열)
const names = Object.keys(ALL);
const cw = 300, ch = 533, cols = 5;
const rows = Math.ceil(names.length / cols);
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cw}" height="${rows * ch}" viewBox="0 0 ${cols * cw} ${rows * ch}">
${names.map((n, i) => {
  const inner = ALL[n](1080, 1920).replace(/<\/?svg[^>]*>/g, '');
  return `<g transform="translate(${(i % cols) * cw},${Math.floor(i / cols) * ch}) scale(${cw / 1080})">
    ${inner}
    <text x="30" y="1860" font-family="sans-serif" font-size="64" fill="#FFFFFF">${n}</text></g>`;
}).join('')}</svg>`;
writeFileSync(join(OUT, '_sheet.png'), new Resvg(sheet, { fitTo: { mode: 'width', value: 1500 } }).render().asPng());
console.log(`  시트: ${join(OUT, '_sheet.png')}`);
