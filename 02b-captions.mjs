#!/usr/bin/env node
/**
 * 02b-captions — timeline.json → build/captions.ass
 *
 * 두 가지 스타일을 낸다:
 *   Talk  하단 대사 자막
 *   Card  상단 숫자/키워드 카드 (script.tsv 6번째 열). 세무·금융 콘텐츠는 숫자가 훅이므로
 *         화면에 크게 띄우면 체류시간이 올라간다. 값이 없으면 그 줄은 카드를 띄우지 않는다.
 *
 * 03-render 를 쓰지 않는 파이프라인(외부 캐릭터 이미지 등)에서 자막만 필요할 때 쓴다.
 * 환경변수: ASPECT=9:16|16:9
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const ASPECT = process.env.ASPECT || '9:16';
const [OW, OH] = ASPECT === '16:9' ? [1920, 1080] : [1080, 1920];

const tl = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));

const ts = s => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`;
};

const talkSize = Math.round(OH * 0.034);
const cardSize = Math.round(OH * 0.055);
const talkMargin = ASPECT === '16:9' ? 56 : 230;
// CAPBOX=1 — 대사 뒤에 불투명 박스를 깐다.
// 오버더숄더처럼 화면 하단이 흰 캐릭터로 덮이는 구도에서는 외곽선만으로는 글자가 묻힌다.
const box = process.env.CAPBOX === '1';
const talkBorder = box ? '3,18,0' : '1,5,2';
const talkOutlineCol = box ? '&H2E120C06' : '&H00201810';
// 카드는 상단 띠 안에 앉아야 한다. 띠 밖으로 내려오면 캐릭터 얼굴을 덮는다.
const cardMargin = ASPECT === '16:9' ? 40 : 150;

const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OW}
PlayResY: ${OH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Talk,Apple SD Gothic Neo,${talkSize},&H00FFFFFF,&H00FFFFFF,${talkOutlineCol},&HA0000000,1,0,0,0,100,100,0,0,${talkBorder},2,80,80,${talkMargin},1
Style: Card,Apple SD Gothic Neo,${cardSize},&H0022E0FF,&H0022E0FF,&H00102030,&HB0000000,1,0,0,0,100,100,1,0,3,14,0,8,60,60,${cardMargin},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

const ev = [];
for (const L of tl.lines) {
  ev.push(`Dialogue: 0,${ts(L.start)},${ts(L.end + 0.18)},Talk,${L.spk},0,0,0,,${L.text.replace(/\n/g, '\\N')}`);
}
// 카드는 같은 값이 이어지면 하나로 합쳐 깜빡임을 막는다
let run = null;
const flush = () => { if (run) ev.push(`Dialogue: 1,${ts(run.start)},${ts(run.end + 0.25)},Card,,0,0,0,,${run.text}`); run = null; };
for (const L of tl.lines) {
  const c = (L.card || '').trim();
  if (!c) { flush(); continue; }
  if (run && run.text === c) run.end = L.end;
  else { flush(); run = { text: c, start: L.start, end: L.end }; }
}
flush();

writeFileSync(join(BUILD, 'captions.ass'), head + ev.join('\n') + '\n');
const cards = ev.filter(e => e.includes(',Card,')).length;
console.log(`자막: 대사 ${tl.lines.length}줄 / 카드 ${cards}개 → build/captions.ass`);
