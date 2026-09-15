#!/usr/bin/env node
/**
 * 14-compose-shot — 배경·책상·캐릭터를 합쳐 **완성 프레임 8장**을 만든다
 *
 * 프레임을 미리 만들어 두는 이유:
 *   렌더 중에 매 프레임 합성하면 좌표를 소수점으로 계산하다 1px 씩 흔들린다.
 *   (화자 위치는 절대 움직이면 안 된다는 요구가 있었다)
 *   미리 만들어 두면 렌더는 "이미 만든 8장 중 하나를 그대로 쓴다"가 되어
 *   눈·입 말고는 물리적으로 바뀔 수가 없다.
 *
 * 배치는 알파 bbox(=캐릭터 실제 외곽) 기준으로 지정한다. 이미지 여백 기준이 아니다.
 *   contentLeft/contentTop = 화면에서 캐릭터 외곽이 시작할 좌표
 *   width                  = 화면에서 캐릭터 외곽의 가로 폭
 * 깊이 순서: 배경 → 화자 → 책상 윗면 → 책상 앞판 → 뒤통수
 *   책상을 **윗면(수평)과 앞판(수직) 두 장으로** 나눈다. 한 장으로 깔면 아래쪽 40%가
 *   균일한 나무판이라 **책상이 아니라 벽처럼** 보인다. 모서리 선 하나로 원근이 생긴다.
 *
 *   ⚠️ 뒤통수는 **맨 앞**이다. 앞판보다 뒤에 두면 하반신이 잘려 나가는데,
 *   그건 "칸막이 뒤에 숨은" 그림이라 오버더숄더가 아니다(실패). 칸막이는 뒤통수에
 *   가려져야 한다. 뒤통수 비중은 레이어가 아니라 **크기와 위치로** 줄인다:
 *   화면 밖(아래·옆)으로 밀어내면 커 보이면서도 차지하는 면적은 작다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
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

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const L = JSON.parse(readFileSync(resolve(ROOT, arg('layout')), 'utf8'));
const OUTDIR = resolve(ROOT, arg('out'));
mkdirSync(OUTDIR, { recursive: true });
const [OW, OH] = [1080, 1920];

/** 알파 bbox 기준 배치 → ffmpeg scale/overlay 인자 */
function place(file, p) {
  const [iw, ih] = dim(join(ROOT, file));
  const [bx0, by0, bx1] = p.content;
  const f = p.width / (bx1 - bx0 + 1);
  const sw = Math.round(iw * f), sh = Math.round(ih * f);
  return { sw, sh, x: Math.round(p.contentLeft - bx0 * f), y: Math.round(p.contentTop - by0 * f) };
}

for (const [spk, C] of Object.entries(L.chars)) {
  const B = L.back?.[spk];
  for (const expr of C.exprs) for (const mouth of ['closed', 'open']) {
    const src = join(ROOT, C.dir, `${spk}_${expr}_${mouth}.png`);
    const S = place(join(C.dir, `${spk}_${expr}_${mouth}.png`), C);

    const ins = [join(ROOT, L.bg), src, join(ROOT, L.desk.img)];
    const bgFx = L.bgFx ? `,${L.bgFx}` : '';
    const dkFx = L.desk.fx ? `,${L.desk.fx}` : '';
    let fc = `[0:v]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH}${bgFx}[bg];` +
             `[1:v]scale=${S.sw}:${S.sh}:flags=lanczos[sp];` +
             `[bg][sp]overlay=${S.x}:${S.y}[a];` +
             `[2:v]scale=${OW}:-1:flags=lanczos${dkFx}[dk];` +
             `[a][dk]overlay=0:${L.desk.top}`;
    let n = 3;
    if (L.apron) {
      ins.push(join(ROOT, L.apron.img));
      const apFx = L.apron.fx ? `,${L.apron.fx}` : '';
      fc += `[b];[${n}:v]scale=${OW}:-1:flags=lanczos${apFx}[ap];[b][ap]overlay=0:${L.apron.top}`;
      n++;
    }
    if (B) {
      const P = place(B.img, B);
      ins.push(join(ROOT, B.img));
      // 전경(뒤통수)은 카메라에 가까워 어둡게 깔린다. 주인공과 자막을 앞으로 끌어낸다.
      const bkFx = B.fx ? `,${B.fx}` : '';
      fc += `[c];[${n}:v]scale=${P.sw}:${P.sh}:flags=lanczos${bkFx}[bk];[c][bk]overlay=${P.x}:${P.y}`;
    }
    const out = join(OUTDIR, `${spk}_${expr}_${mouth}.png`);
    execFileSync(FFMPEG, ['-y', '-v', 'error', ...ins.flatMap(i => ['-i', i]),
      '-filter_complex', fc, '-frames:v', '1', out]);
    console.log(`✓ ${spk}_${expr}_${mouth}  캐릭터 ${S.sw}x${S.sh} @ (${S.x},${S.y})`);
  }
}
