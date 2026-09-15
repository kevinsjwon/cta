#!/usr/bin/env node
/**
 * 16b-sync-ears — 재구성한 귀를 **한 장에서 복사해 나머지 표정에 강제 동기화**한다
 *
 * ⚠️ 표정마다 따로 재구성하면 안 된다. 띠 검출은 안티에일리어싱에 민감해서
 *    한 장만 실패해도 그 표정에서 귀 모양이 달라진다(실측: close_02_설명 좌측 귀
 *    검출 실패 → 기본과 2,086px 차이). 그러면 입이 열릴 때 **귀가 같이 움직인다.**
 *    귀는 표정과 무관하므로 기준 한 장에서 복사하는 것이 옳다.
 *
 * 사용: node bin/16b-sync-ears.mjs <기준> <K> <대상...>
 */
import { execFileSync } from 'node:child_process';
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

const [REF, KS, ...TARGETS] = process.argv.slice(2);
const K = +KS;
const [W, H] = dim(REF);
const rd = f => Buffer.from(execFileSync(FFMPEG, ['-v', 'error', '-i', f,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: W * H * 4 + 8192 }));
const ref = rd(REF);

for (const t of TARGETS) {
  const [w, h] = dim(t);
  if (w !== W || h !== H) throw new Error(`${t}: 크기가 기준과 다릅니다 (${w}x${h} != ${W}x${H})`);
  const buf = rd(t);
  ref.copy(buf, 0, 0, K * W * 4);          // 재구성 구간(위 K행)을 통째로 덮어쓴다
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', '1', t], { input: buf });
  console.log(`  ${t.split('/').pop()} ← 귀 ${K}행 동기화`);
}
