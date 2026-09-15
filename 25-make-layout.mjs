#!/usr/bin/env node
/**
 * 25-make-layout — measured.json + 규칙 → **input/layout_{closeup,dialogue}.json**
 *
 * 배치 숫자를 손으로 적지 않게 한다. 캐릭터가 바뀌면 bbox 가 바뀌고, bbox 가 바뀌면
 * contentTop 을 같이 고쳐야 하는데 이걸 놓치면 캐릭터가 위아래로 튄다(실측 반복).
 *
 * 규칙 (§8.6 에서 확정된 것들)
 *   · 컷아웃은 가슴에서 잘려 있다 → **책상 윗선 = 화자 컨텐츠 아래끝 − 15**
 *   · 책상은 윗면 + 앞판 두 장. 앞판은 화면을 벽처럼 보이게 하는 걸 막는다
 *   · 뒤통수는 **맨 앞**. 칸막이(앞판)에 가리면 안 된다
 *   · 뒤통수 윗선 > 화자 입 아래끝  (얼굴을 가리면 절대 안 된다)
 *   · 배치는 전부 **알파 bbox 기준**. 이미지 여백 기준이 아니다
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');
const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const M = JSON.parse(readFileSync(arg('measured') || 'build/measured.json', 'utf8'));
const V = arg('vdir') || 'build/cu/v2';
const [OW, OH] = [1080, 1920];
const PLATE = { bg: 'build/cu/plate/shelf.png', top: 'build/cu/plate/desk_top.png', front: 'build/cu/plate/desk_front.png' };
const bboxOf = f => {                       // v2 이미지의 알파 bbox (귀 복원으로 원본과 다르다)
  const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'tool-bbox.mjs'), f], { encoding: 'utf8' });
  const m = out.match(/x(\d+)-(\d+).*?y(\d+)-(\d+)/);
  return [+m[1], +m[3], +m[2], +m[4]];
};
const ids = Object.keys(M);
const [A, B] = ids;                          // A = 답변자(첫 화자), B = 질문자

/** 화자 블록: 원하는 폭과 "컨텐츠 아래끝" 으로 contentTop 을 역산한다 */
function charBlock(sid, width, bottom) {
  const f = join(V, `${sid}_${M[sid].neutral}_closed.png`);
  const bb = bboxOf(f);
  const cw = bb[2] - bb[0] + 1, ch = bb[3] - bb[1] + 1;
  const scale = width / cw;
  return {
    block: {
      dir: V, exprs: Object.keys(M[sid].foldsToNeutral).filter(e => !M[sid].foldsToNeutral[e]).concat([M[sid].neutral])
        .filter((v, i, s) => s.indexOf(v) === i),
      content: bb, width, contentLeft: Math.round((OW - width) / 2), contentTop: Math.round(bottom - ch * scale),
    },
    scale, ch, bb,
    mouthBottom: bottom - ch * scale + (M[sid].mouthROI[3] + (M[sid].ears.cut ? M[sid].ears.K : 0) - bb[1]) * scale,
  };
}
function backBlock(sid, width, top, left) {
  const f = join(V, `${sid}_back.png`);
  if (!existsSync(f)) return null;
  const bb = bboxOf(f);
  return {
    img: f, content: bb, width, contentLeft: left, contentTop: top,
    fx: 'eq=brightness=-0.14:saturation=0.85:contrast=0.95',
  };
}

// ── 클로즈업: 화자 하나만 크게. 책상 윗면은 얇고 앞판이 자막 자리를 만든다.
{
  const chars = {};
  const BOTTOM = 1460;
  for (const sid of ids) chars[sid] = charBlock(sid, sid === A ? Math.round(OW * 0.954) : Math.round(OW * 0.926), BOTTOM).block;
  const L = {
    bg: PLATE.bg, bgFx: 'gblur=sigma=5,eq=brightness=-0.06:saturation=0.88',
    desk: { img: PLATE.top, top: BOTTOM - 40, fx: 'eq=brightness=-0.02' },
    apron: { img: PLATE.front, top: 1580 },
    chars,
  };
  writeFileSync('input/layout_closeup.json', JSON.stringify(L, null, 2) + '\n');
  console.log(`✓ input/layout_closeup.json   책상 ${L.desk.top} / 앞판 ${L.apron.top}`);
}

// ── 오버더숄더: 화자 + 상대 뒤통수(맨 앞). 뒤통수 윗선은 화자 입보다 아래여야 한다.
{
  const BOTTOM = 1105, DESK = BOTTOM - 15, APRON = 1360, BACKTOP = 1330;
  const chars = {}, back = {};
  const info = {};
  for (const sid of ids) {
    const r = charBlock(sid, sid === A ? Math.round(OW * 0.704) : Math.round(OW * 0.667), BOTTOM);
    chars[sid] = r.block; info[sid] = r;
  }
  const other = sid => ids.find(x => x !== sid);
  for (const sid of ids) {
    const o = other(sid);
    const b2 = backBlock(o, Math.round(OW * (o === A ? 0.954 : 0.75)), BACKTOP, o === A ? 500 : -160);
    if (b2) back[sid] = b2;
    if (BACKTOP <= info[sid].mouthBottom)
      console.log(`  ⚠️ ${sid}: 뒤통수 윗선(${BACKTOP}) 이 화자 입 아래끝(${Math.round(info[sid].mouthBottom)}) 보다 위입니다 → 얼굴을 가립니다`);
  }
  const L = {
    bg: PLATE.bg, bgFx: 'gblur=sigma=6,eq=brightness=-0.07:saturation=0.86',
    desk: { img: PLATE.top, top: DESK, fx: 'eq=brightness=-0.02' },
    apron: { img: PLATE.front, top: APRON },
    chars, back,
  };
  writeFileSync('input/layout_dialogue.json', JSON.stringify(L, null, 2) + '\n');
  console.log(`✓ input/layout_dialogue.json  책상 ${DESK} / 앞판 ${APRON} / 뒤통수 윗선 ${BACKTOP}`);
  for (const sid of ids) console.log(`   ${sid} 입 아래끝 ${Math.round(info[sid].mouthBottom)}`);
}
