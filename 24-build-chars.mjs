#!/usr/bin/env node
/**
 * 24-build-chars — measured.json 을 따라 **(화자 × 표정 × 입) 조합 이미지**를 만든다
 *
 *   build/cu/v2/{화자}_{표정}_{closed|open}.png
 *   build/cu/v2/{화자}_back.png
 *   input/exprmap.json        ← 렌더러가 쓸 "표정 → 프레임" 매핑
 *
 * 하는 일 (전부 measured.json 의 실측값으로 결정된다)
 *   1) 귀가 잘렸으면 16-rebuild-ears → 16b-sync-ears (표정 간 귀 강제 동일화)
 *   2) 귀 복원으로 이미지가 K 만큼 커졌으므로 **ROI 의 y 를 K 만큼 민다**
 *   3) 기본 그림 하나를 베이스로 눈·입만 갈아끼워 조합을 만든다
 *
 * ⚠️ 절대 표정 이미지를 통째로 갈아끼우지 않는다. 외곽선 안티에일리어싱이 달라
 *    캐릭터 전체가 지글거린다(§8.6).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => { try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {} return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'); })();
const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const M = JSON.parse(readFileSync(arg('measured') || 'build/measured.json', 'utf8'));
const SRC = arg('dir') || 'build/cast';
const EARS = 'build/cu/ears';
const OUT = arg('out') || 'build/cu/v2';
mkdirSync(EARS, { recursive: true }); mkdirSync(OUT, { recursive: true });
const node = process.execPath;
const run = (s, args) => execFileSync(node, [join(ROOT, 'bin', s), ...args], { stdio: 'pipe', encoding: 'utf8' });
const shift = (r, k) => [r[0], r[1] + k, r[2], r[3] + k].join(',');

const exprmap = {};
for (const [sid, m] of Object.entries(M)) {
  let base = SRC, K = 0;
  if (m.ears.cut) {
    K = m.ears.K;
    const spans = m.ears.spans.map(s => s.join(',')).join(' ');
    let inDir = SRC, trim = m.ears.trimTop || 0;
    for (const e of m.exprs) {
      let src = join(inDir, `${sid}_${e}.png`);
      if (trim) {
        const t = join(EARS, `_trim_${sid}_${e}.png`);
        execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', src, '-vf', `crop=in_w:in_h-${trim}:0:${trim}`, t]);
        src = t;
      }
      run('16-rebuild-ears.mjs', [src, join(EARS, `${sid}_${e}.png`),
        '--ears', spans, '--k', String(K), '--ratio', '1.074', '--smooth', '44', '--post', '40']);
    }
    // ⚠️ 표정마다 따로 재구성하면 띠 검출이 한 장만 실패해도 귀가 달라져 입이 열릴 때 귀가 움직인다
    run('16b-sync-ears.mjs', [join(EARS, `${sid}_${m.neutral}.png`), String(K),
      ...m.exprs.filter(e => e !== m.neutral).map(e => join(EARS, `${sid}_${e}.png`))]);
    base = EARS;
    console.log(`  ${sid}: 귀 복원 +${K}px (${m.exprs.length}장) + 동기화`);
  } else {
    console.log(`  ${sid}: 귀 잘림 없음 → 원본 그대로`);
  }

  const B = join(base, `${sid}_${m.neutral}.png`);
  const MR = shift(m.mouthROI, K);
  const ER = m.eyeROI.map(r => shift(r, K));
  const open = m.mouthOpenFrom;
  const g = (out, grafts) => run('13-graft-aligned.mjs',
    ['--base', B, '--out', join(OUT, out), ...grafts.flatMap(x => ['--graft', x])]);

  copyFileSync(B, join(OUT, `${sid}_${m.neutral}_closed.png`));
  g(`${sid}_${m.neutral}_open.png`, [`${join(base, `${sid}_${open}.png`)}:${MR}`]);
  exprmap[sid] = { [m.neutral]: m.neutral };
  for (const e of m.exprs) {
    if (e === m.neutral) continue;
    if (m.foldsToNeutral[e]) { exprmap[sid][e] = m.neutral; continue; }   // 눈이 기본과 같다 → 접는다
    exprmap[sid][e] = e;
    const eyes = ER.map(r => `${join(base, `${sid}_${e}.png`)}:${r}`);
    // 입이 열린 표정(놀람 등)은 **자기 입을 closed 로 쓰면 안 된다** → 기본 입을 쓴다
    const closedMouth = m.mouthOpen[e] ? null : `${join(base, `${sid}_${e}.png`)}:${MR}`;
    g(`${sid}_${e}_closed.png`, [...eyes, ...(closedMouth ? [closedMouth] : [])]);
    g(`${sid}_${e}_open.png`, [...eyes, `${join(base, `${sid}_${open}.png`)}:${MR}`]);
  }

  const bk = join(base === EARS ? EARS : SRC, `${sid}_back.png`);
  if (m.back) {
    if (m.back.ears.cut) {
      let src = join(SRC, `${sid}_back.png`);
      const t2 = m.back.ears.trimTop || 0;
      if (t2) {
        const t = join(EARS, `_trim_${sid}_back.png`);
        execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', src, '-vf', `crop=in_w:in_h-${t2}:0:${t2}`, t]);
        src = t;
      }
      // ⚠️ 뒤통수는 귓속 구조가 없어 띠 모델이 대각선 주름을 만든다 → --noband
      run('16-rebuild-ears.mjs', [src, join(OUT, `${sid}_back.png`),
        '--ears', m.back.ears.spans.map(s => s.join(',')).join(' '), '--k', String(m.back.ears.K),
        '--ratio', '1.074', '--noband', '1', '--smooth', '60', '--post', '40']);
      console.log(`  ${sid}: 뒤통수 귀 복원 +${m.back.ears.K}px`);
    } else copyFileSync(join(SRC, `${sid}_back.png`), join(OUT, `${sid}_back.png`));
  }
}
writeFileSync('input/exprmap.json', JSON.stringify(exprmap, null, 2) + '\n');
console.log(`\n✓ ${OUT}`);
console.log(execFileSync('sh', ['-c', `ls ${OUT}/*.png | sed 's|.*/|  |'`], { encoding: 'utf8' }));
console.log(`✓ input/exprmap.json  ${JSON.stringify(exprmap)}`);
