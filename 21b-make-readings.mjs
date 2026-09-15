#!/usr/bin/env node
/**
 * 21b-make-readings — script.tsv 의 **숫자 표기를 한글 수사로** 바꿔 readings.tsv 를 만든다
 *
 * 없으면 `say` 가 숫자를 **한 자리씩** 읽는다("이천백사십오" 대신 "이 일 사 오").
 * 발음이 틀릴 뿐 아니라 길이가 크게 늘어 목표 시간을 넘긴다(실측 54s → 62s).
 *
 * 한자어 수사 규칙: 일십/일백/일천 은 십/백/천 으로 줄인다. 만·억 단위로 4자리씩 끊는다.
 * 이미 등록된 항목은 건드리지 않는다(사람이 손본 값이 우선).
 *
 * ⚠️ 자동 변환은 **초안이다.** 고유명사·연도·전화번호 등은 읽는 법이 다를 수 있으니
 *    출력된 readings.tsv 를 한 번 훑어볼 것.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const SRC = arg('script') || 'input/script.tsv';
const OUT = arg('out') || 'input/readings.tsv';

const D = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const U = ['', '십', '백', '천'];
const BIG = ['', '만', '억', '조'];

/** 0~9999 → 한글 (일십/일백/일천 축약) */
function under4(n) {
  let s = '';
  for (let i = 3; i >= 0; i--) {
    const d = Math.floor(n / 10 ** i) % 10;
    if (!d) continue;
    s += (d === 1 && i > 0) ? U[i] : D[d] + U[i];
  }
  return s;
}
function sino(numStr) {
  let n = BigInt(numStr.replace(/,/g, ''));
  if (n === 0n) return '영';
  const parts = [];
  for (let g = 0; n > 0n; g++) {
    const chunk = Number(n % 10000n);
    if (chunk) parts.unshift(under4(chunk) + BIG[g]);
    n /= 10000n;
  }
  return parts.join('');
}

// ⚠️ 단위는 **연속으로** 붙는다(만원 / 억원). 한 글자만 잡으면 '2,145만' 까지만 바뀌어
//    뒤의 '원' 이 따로 읽히고, 치환 대상이 대본의 '2,145만원' 과 안 맞는다(실측).
const UNIT = { '%': '퍼센트', '원': '원', '억': '억', '만': '만', '년': '년', '월': '월', '일': '일', '개': '개', '번': '번', '차': '차', '배': '배' };
const text = readFileSync(SRC, 'utf8').trim().split('\n').map(l => l.split('\t')[3] || '').join(' ');

const found = new Map();
// 숫자(쉼표 포함) + 뒤따르는 단위 한 글자
const re = /([0-9][0-9,]*)\s*([%원억만년월일개번차배]*)/g;
let m;
while ((m = re.exec(text))) {
  const [whole, num, unit] = m;
  const key = whole.trim();
  if (!key || found.has(key)) continue;
  let read = sino(num);
  for (const ch of unit || '') read += UNIT[ch] ?? ch;
  found.set(key, read);
}

const prev = new Map();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, 'utf8').split('\n')) {
    const [k, v] = l.split('\t');
    if (k && v) prev.set(k, v);          // 사람이 손본 값이 우선
  }
}
const rows = [];
for (const [k, v] of found) if (!prev.has(k)) rows.push([k, v]);
const all = [...prev.entries(), ...rows];
// 긴 표기를 먼저 치환해야 '1억' 이 '1' 로 먼저 바뀌지 않는다
all.sort((p, q) => q[0].length - p[0].length);
writeFileSync(OUT, all.map(r => r.join('\t')).join('\n') + '\n');

console.log(`✓ ${OUT}  총 ${all.length}개 (신규 ${rows.length})`);
for (const [k, v] of rows.slice(0, 12)) console.log(`   ${k} → ${v}`);
if (rows.length > 12) console.log(`   … 외 ${rows.length - 12}개`);
console.log('⚠️ 연도·고유명사 등 읽는 법이 다를 수 있으니 한 번 훑어볼 것');
