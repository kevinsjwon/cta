#!/usr/bin/env node
/**
 * 02-build-visemes — 한국어 텍스트 → 프레임 단위 입모양 타임라인
 *
 * 결정론적이다. 같은 입력이면 어느 컴퓨터에서도 같은 출력이 나온다.
 * (Math.random / Date.now 를 쓰지 않고 시드 LCG 를 사용)
 *
 * 원리: 한국어는 음절 문자이므로 텍스트만으로 입모양을 뽑을 수 있다.
 *   1. 유니코드 한글 음절을 초성/중성/종성으로 분해
 *   2. 중성(모음)이 입 모양을 결정한다 — 자음은 입 모양에 거의 영향이 없다
 *   3. 양순 종성(ㅁ/ㅂ/ㅍ/ㅄ/ㄻ/ㄼ/ㄿ)은 입을 닫는다 → M 프레임 삽입
 *   4. 구두점에서 짧은 휴지(X) 삽입
 *   5. 음절을 구간 길이에 비례 배분 → MOUTH_FPS 로 양자화
 *
 * 영어권 도구(Rhubarb 등)는 영어 음소 인식기를 쓰므로 한국어 정확도가 떨어진다.
 * 이 방식은 음성 인식을 거치지 않아 오인식이 원리적으로 없다.
 *
 * 입력:  build/timeline.json          (01단계 산출)
 *        input/readings.tsv (선택)    비한글 표기 → 한글 읽기 매핑
 * 출력:  build/visemes.json           화자별 프레임 타임라인
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');

// ── 입 모양 집합 ────────────────────────────────────────────────────
// 캐릭터 에셋은 이 9개 키에 대응하는 이미지/SVG를 제공하면 된다.
export const SHAPES = {
  A:  '크게 벌림      ㅏ ㅑ',
  E:  '옆으로 벌림    ㅐ ㅔ ㅒ ㅖ',
  EO: '중간 벌림      ㅓ ㅕ',
  O:  '둥글게         ㅗ ㅛ',
  U:  '오므림         ㅜ ㅠ ㅡ',
  I:  '좁게 옆으로    ㅣ',
  M:  '완전히 닫힘    양순음 종성 / 무음',
  X:  '휴지(살짝 닫힘) 문장 사이',
  R:  '쉼(기본 자세)  발화 없음',
};

// 중성 21종 → 입 모양. 이중모음은 [선행, 후행] 두 단계로 전이한다.
const JUNG = [
  ['A'], ['E'], ['A'], ['E'],            // ㅏ ㅐ ㅑ ㅒ
  ['EO'], ['E'], ['EO'], ['E'],          // ㅓ ㅔ ㅕ ㅖ
  ['O'], ['O', 'A'], ['O', 'E'], ['O', 'E'], // ㅗ ㅘ ㅙ ㅚ
  ['O'],                                  // ㅛ
  ['U'], ['U', 'EO'], ['U', 'E'], ['U', 'I'], // ㅜ ㅝ ㅞ ㅟ
  ['U'],                                  // ㅠ
  ['U'], ['U', 'I'], ['I'],              // ㅡ ㅢ ㅣ
];

// 양순음 종성 인덱스: ㄻ(10) ㄼ(11) ㄿ(14) ㅁ(16) ㅂ(17) ㅄ(18) ㅍ(26)
const BILABIAL_JONG = new Set([10, 11, 14, 16, 17, 18, 26]);

const SYL_BASE = 0xac00, SYL_LAST = 0xd7a3;

/** 한글 음절 1자 → 입모양 배열. 한글이 아니면 null */
function syllableShapes(ch) {
  const c = ch.codePointAt(0);
  if (c < SYL_BASE || c > SYL_LAST) return null;
  const idx = c - SYL_BASE;
  const jung = Math.floor(idx / 28) % 21;
  const jong = idx % 28;
  const shapes = [...JUNG[jung]];
  if (BILABIAL_JONG.has(jong)) shapes.push('M');
  return shapes;
}

// ── 비한글 표기 처리 ────────────────────────────────────────────────
// TTS 는 "AI" 를 "에이아이" 로 읽는다. 입모양도 같은 읽기를 따라야 한다.
// input/readings.tsv 에 `표기<TAB>한글읽기` 를 넣으면 치환된다.
function loadReadings() {
  const f = join(ROOT, 'input', 'readings.tsv');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('\t'))
    .filter(p => p.length >= 2)
    .sort((a, b) => b[0].length - a[0].length); // 긴 표기 우선
}
function applyReadings(text, map) {
  let t = text;
  for (const [from, to] of map) t = t.split(from).join(to);
  return t;
}

// ── 텍스트 → 입모양 시퀀스 (구두점 = 휴지) ──────────────────────────
const PAUSE_CHARS = new Set([',', '.', '?', '!', '…', '·', ';', ':']);

/** 텍스트를 [{shapes:[...]}, ...] 단위 슬롯 배열로. 슬롯 1개 = 음절 1개 분량의 시간 */
function textToSlots(text, readings) {
  const t = applyReadings(text, readings);
  const slots = [];
  for (const ch of t) {
    if (PAUSE_CHARS.has(ch)) {
      // 구두점은 음절 반 개 분량의 휴지
      slots.push({ shapes: ['X'], weight: 0.5 });
      continue;
    }
    if (ch === ' ') continue;
    const s = syllableShapes(ch);
    if (s) {
      slots.push({ shapes: s, weight: 1 });
    } else if (/[A-Za-z0-9]/.test(ch)) {
      // readings.tsv 미등록 라틴/숫자: 중립 개폐로 폴백 (경고는 호출부에서)
      slots.push({ shapes: ['E'], weight: 1, fallback: ch });
    }
    // 그 외 기호는 무시
  }
  return slots;
}

// ── 시드 PRNG (재현성 보장: Math.random 금지) ───────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

// ── 메인 ────────────────────────────────────────────────────────────
const tl = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const readings = loadReadings();
const FPS = tl.mouthFps;
const nFrames = Math.ceil(tl.total * FPS);
const fallbacks = new Set();

// 화자별 프레임 배열 초기화 (발화 없는 구간 = R)
const frames = {};
for (const s of tl.speakers) frames[s.id] = new Array(nFrames).fill('R');

for (const L of tl.lines) {
  const slots = textToSlots(L.text, readings);
  slots.forEach(s => { if (s.fallback) fallbacks.add(s.fallback); });
  if (!slots.length) continue;

  const totalW = slots.reduce((a, s) => a + s.weight, 0);
  const f0 = Math.round(L.start * FPS);
  const f1 = Math.round(L.end * FPS);
  const span = Math.max(1, f1 - f0);

  // 슬롯을 가중치 비례로 프레임에 배분. 슬롯 내 다중 shape(이중모음/양순종성)는
  // 슬롯 프레임을 다시 균등 분할해 전이시킨다.
  let acc = 0;
  for (const slot of slots) {
    const a = f0 + Math.round((acc / totalW) * span);
    acc += slot.weight;
    const b = f0 + Math.round((acc / totalW) * span);
    const len = Math.max(1, b - a);
    const k = slot.shapes.length;
    for (let i = 0; i < len; i++) {
      const f = a + i;
      if (f < 0 || f >= nFrames) continue;
      frames[L.spk][f] = slot.shapes[Math.min(k - 1, Math.floor((i / len) * k))];
    }
  }
  // 발화 끝에 닫힘 1프레임 (말이 끊긴 느낌 방지)
  if (f1 < nFrames) frames[L.spk][f1] = 'X';
}

// ── 눈 깜빡임 (시드 고정 → 재현 가능) ───────────────────────────────
// 3~5초 간격, 2프레임. 말하는 중에도 깜빡이므로 입과 독립적으로 관리한다.
const blinks = {};
for (const s of tl.speakers) {
  const rng = makeRng([...s.id].reduce((a, c) => a + c.charCodeAt(0), 7919));
  const list = [];
  let t = 1.0 + rng() * 2;
  while (t < tl.total) { list.push(+t.toFixed(3)); t += 3 + rng() * 2; }
  blinks[s.id] = list;
}

// ── 런렝스 압축 (렌더러가 읽기 쉬운 형태) ───────────────────────────
function runLength(arr) {
  const out = [];
  let cur = arr[0], start = 0;
  for (let i = 1; i <= arr.length; i++) {
    if (i === arr.length || arr[i] !== cur) {
      out.push({ f: start, n: i - start, s: cur });
      cur = arr[i]; start = i;
    }
  }
  return out;
}

const out = {
  fps: FPS,
  totalFrames: nFrames,
  total: tl.total,
  shapes: Object.keys(SHAPES),
  speakers: tl.speakers.map(s => ({
    ...s,
    mouth: runLength(frames[s.id]),
    blinks: blinks[s.id],
    speakingRanges: tl.lines.filter(L => L.spk === s.id).map(L => [L.start, L.end]),
  })),
};
writeFileSync(join(BUILD, 'visemes.json'), JSON.stringify(out, null, 2));

// ── 리포트 ──────────────────────────────────────────────────────────
console.log(`입모양 타임라인: ${FPS}fps × ${nFrames}프레임 (${tl.total}s)`);
for (const s of out.speakers) {
  const spoken = s.mouth.filter(r => r.s !== 'R').reduce((a, r) => a + r.n, 0);
  const dist = {};
  s.mouth.forEach(r => { if (r.s !== 'R') dist[r.s] = (dist[r.s] || 0) + r.n; });
  const top = Object.entries(dist).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  ${s.id} (${s.label}) 발화 ${spoken}프레임 / 전환 ${s.mouth.length}회 / 깜빡임 ${s.blinks.length}회`);
  console.log(`     분포 ${top}`);
}
if (fallbacks.size) {
  console.log(`\n⚠️  readings.tsv 미등록 비한글 표기: ${[...fallbacks].join(', ')}`);
  console.log(`    input/readings.tsv 에 "표기<TAB>한글읽기" 를 추가하면 정확해집니다.`);
  console.log(`    예:  AI\\t에이아이`);
}
