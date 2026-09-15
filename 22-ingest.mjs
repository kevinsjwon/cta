#!/usr/bin/env node
/**
 * 22-ingest — cast.json 의 원본 이미지 → **정규 이름의 정렬된 컷아웃**
 *
 *   build/cast/{화자}_{표정}.png     앞모습 (기본 표정의 bbox 에 정렬됨)
 *   build/cast/{화자}_back.png       뒤통수 (정렬하지 않는다 — 실루엣이 달라 기준이 다르다)
 *
 * 하는 일
 *   1) 04c-dechecker : 체커보드가 구워진 PNG → 진짜 알파
 *   2) 08-align      : 표정끼리 알파 bbox 를 맞춘다 (안 맞으면 표정 바뀔 때 캐릭터가 흔들린다)
 *
 * ⚠️ 정렬 후 bbox 가 **1~2px 이내로 같지 않으면 그대로 진행하지 말 것.** 이후 단계는
 *    "표정끼리 픽셀 단위로 정렬돼 있다"는 전제 위에 서 있다(§8.6).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const CAST = arg('cast') || 'input/cast.json';
const OUT = arg('out') || 'build/cast';
const TOL = arg('tol') || '14';
const cast = JSON.parse(readFileSync(CAST, 'utf8'));
const TMP = join(ROOT, 'build', '_ingest_tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });
const node = process.execPath;
const run = (s, args) => execFileSync(node, [join(ROOT, 'bin', s), ...args], { stdio: 'pipe', encoding: 'utf8' });

for (const [sid, sp] of Object.entries(cast.speakers)) {
  const neutral = sp.neutral;
  if (!neutral || !sp.front[neutral]) { console.error(`${sid}: 기본 표정(neutral)이 없습니다`); process.exit(1); }
  const names = [neutral, ...Object.keys(sp.front).filter(e => e !== neutral)];

  const de = [];
  for (const e of names) {
    const t = join(TMP, `${sid}_${e}.png`);
    run('04c-dechecker.mjs', [sp.front[e], t, TOL]);
    de.push(t);
  }
  run('08-align-expressions.mjs', [TMP + '/al', ...de]);
  // ⚠️ 체커 제거 후 남는 **고립 잔재**를 먼저 지운다. 안 지우면 알파 bbox 가 통째로
  //    틀어져(실측 x195→x0) 이후 배치 계산이 전부 어긋난다.
  for (const e of names) {
    const k = join(TMP, `k_${sid}_${e}.png`);
    run('tool-keepmain.mjs', [join(TMP, 'al', `${sid}_${e}.png`), k]);
    run('tool-despeck.mjs', [k, join(OUT, `${sid}_${e}.png`)]);   // 흰 잔재 제거 (§8.6)
  }

  if (sp.back) {
    const t = join(TMP, `${sid}_back.png`);
    run('04c-dechecker.mjs', [sp.back, t, TOL]);
    const k = join(TMP, `k_${sid}_back.png`);
    run('tool-keepmain.mjs', [t, k]);
    run('tool-despeck.mjs', [k, join(OUT, `${sid}_back.png`)]);
  } else {
    console.log(`  ⚠️ ${sid}: 뒤통수가 없습니다 → 오버더숄더 컷을 만들 수 없습니다`);
  }
  console.log(`  ${sid}: 앞모습 ${names.length}장 + 뒤통수 ${sp.back ? 1 : 0}장`);
}

console.log(`\n✓ ${OUT}`);
console.log(execFileSync(node, [join(ROOT, 'bin', 'tool-bbox.mjs'),
  ...execFileSync('sh', ['-c', `ls ${OUT}/*.png`], { encoding: 'utf8' }).trim().split('\n')],
  { encoding: 'utf8' }));
console.log('⚠️ 같은 화자의 앞모습끼리 bbox 가 1~2px 이내인지 확인할 것.');
