#!/usr/bin/env node
/**
 * 20-scan-assets — 에셋 폴더 → **input/cast.json** (이후 모든 단계의 정본)
 *
 * ── 입력 계약 (권장: 폴더 방식) ────────────────────────────────
 *   assets/
 *     <캐릭터이름>/          ← 폴더 이름이 **대본 docx 의 화자 이름과 같아야 한다**
 *       앞_기본.png          ← 필수. 무표정/기본 앞모습
 *       앞_<표정>.png        ← 0개 이상 (설명, 경고, 놀람, 입벌림 …)
 *       뒤.png               ← 필수. 뒤통수 (오버더숄더 전경용)
 *     scene.png              ← 선택. 배경·책상 판을 떠올 완성 장면
 *     대본.docx
 *
 *   접두어는 `앞_`/`뒤` 대신 `front_`/`back` 도 된다. 그 외 파일명은 자유다.
 *
 * ⚠️ **평평한 폴더(파일명으로만 구분)도 받지만 권장하지 않는다.** 실제로 받아 본 파일명은
 *    close_01_기본.png.png / tori_01b_입벌림.png.png / 01_대화장면_너굴정면.png.png 처럼
 *    캐릭터 접두어가 제각각이라 토큰 추측이 **자주 틀린다**(실측: 5명으로 잘못 분리됨).
 *    평평한 폴더를 쓸 거면 반드시 출력된 cast.json 을 눈으로 확인하고 고칠 것.
 *
 * ⚠️ '입 열린 그림'이 어느 표정인지는 여기서 정하지 않는다. 파일명(설명/입벌림/talk…)은
 *    믿을 수 없다. `23-measure` 가 픽셀 차이로 판정해 cast.json 에 채워 넣는다.
 */
import { readdirSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const DIR = a.find((v, i) => !v.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
const OUT = arg('out') || 'input/cast.json';
if (!DIR || !existsSync(DIR)) {
  console.error('사용: node bin/20-scan-assets.mjs <에셋폴더> [--out input/cast.json]');
  process.exit(1);
}

const IMG = /\.(png|jpe?g|webp)$/i;
// ⚠️⚠️ macOS 의 readdir 은 한글 파일명을 **NFD(자모 분리)** 로 준다.
//    소스의 '뒤통수'(NFC)와 includes 비교하면 **항상 false** 가 나온다(실측: 캐릭터가
//    5명으로 잘못 분리됨). 파일명은 만질 때마다 반드시 normalize('NFC') 를 거친다.
const nfc = s => s.normalize('NFC');
// ⚠️ cast.json 에 적히는 **경로도 NFC 로 정규화**한다. readdir 이 준 NFD 를 그대로 저장하면
//    macOS 안에서는 되지만(APFS 조회가 정규화 무시) 리눅스·윈도우로 옮기면 파일을 못 찾는다.
const P = (...xs) => join(...xs).normalize('NFC');
const strip = f => nfc(basename(f)).replace(/(\.png|\.jpe?g|\.webp)+$/i, '');
const has = (s, ks) => ks.some(k => nfc(s).toLowerCase().includes(nfc(k)));
const BACK = ['뒤통수', '뒷모습', 'back', 'rear', '뒤'];
const FRONT = ['앞', 'front'];
const SCENE = ['대화장면', 'scene', '배경'];

const entries = readdirSync(DIR);
const subdirs = entries.filter(e => { try { return statSync(P(DIR, e)).isDirectory(); } catch { return false; } });

const cast = { assetDir: DIR, mode: null, speakers: {}, scenes: [] };
const ids = ['N', 'T', 'S3', 'S4', 'S5'];

if (subdirs.length) {
  // ── 권장 경로: 폴더 = 캐릭터
  cast.mode = 'folder';
  subdirs.forEach((name, i) => {
    const fs2 = readdirSync(P(DIR, name)).filter(f => IMG.test(f));
    const back = fs2.find(f => has(strip(f), BACK));
    const front = {};
    for (const f of fs2) {
      if (f === back) continue;
      let e = strip(f);
      for (const p of FRONT) e = e.replace(new RegExp(`^${p}[_\\-\\s]*`, 'i'), '');
      front[e.replace(/^[0-9]+[_\-\s]*/, '') || '기본'] = P(DIR, name, f);
    }
    const neutral = Object.keys(front).find(k => has(k, ['기본', 'neutral', 'default', 'idle'])) || Object.keys(front)[0];
    cast.speakers[ids[i] || `S${i}`] = {
      name: nfc(name), role: i === 0 ? '답변자' : '질문자',
      front, back: back ? P(DIR, name, back) : null, neutral, mouthOpenFrom: null,
    };
  });
  cast.scenes = entries.filter(f => IMG.test(f) && has(strip(f), SCENE)).map(f => P(DIR, f));
  if (!cast.scenes.length) cast.scenes = entries.filter(f => IMG.test(f)).map(f => P(DIR, f));
} else {
  // ── 평평한 폴더: 추측한다. 반드시 검수 필요.
  cast.mode = 'flat(검수 필요)';
  const files = entries.filter(f => IMG.test(f));
  const scenes = files.filter(f => has(strip(f), SCENE));
  const rest = files.filter(f => !scenes.includes(f));
  const tok = f => strip(f).split(/[_\-\s]+/).filter(Boolean);   // strip 이 이미 NFC
  // 캐릭터 접두어 후보 = 각 파일의 **첫 비숫자 토큰**. 같은 값끼리 묶는다.
  const key = f => tok(f).find(t => !/^\d+[a-z]?$/i.test(t)) || tok(f)[0];
  const groups = new Map();
  for (const f of rest) { const k = key(f); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
  [...groups.entries()].forEach(([k, fs2], i) => {
    const back = fs2.find(f => has(strip(f), BACK));
    const front = {};
    for (const f of fs2) {
      if (f === back) continue;
      front[tok(f).filter(t => t !== k && !/^\d+[a-z]?$/i.test(t)).join('_') || '기본'] = P(DIR, f);
    }
    const neutral = Object.keys(front).find(x => has(x, ['기본', 'neutral', 'default'])) || Object.keys(front)[0];
    cast.speakers[ids[i] || `S${i}`] = {
      name: k, role: i === 0 ? '답변자' : '질문자',
      front, back: back ? P(DIR, back) : null, neutral, mouthOpenFrom: null,
    };
  });
  cast.scenes = scenes.map(f => P(DIR, f));
}

writeFileSync(OUT, JSON.stringify(cast, null, 2) + '\n');
console.log(`✓ ${OUT}   (모드: ${cast.mode})`);

// ── 에셋에서 유도할 수 없는 설정 파일은 **기본값으로 만들어 둔다.**
//    없으면 01-build-audio 가 곧바로 죽는다. "캐릭터 폴더 + 대본" 만으로 돌게 하는 조건.
const IN = dirname(OUT);
if (!existsSync(join(IN, 'timing.conf'))) {
  writeFileSync(join(IN, 'timing.conf'),
    'COLD_OPEN=1.00\nOUTRO=1.80\nMOUTH_FPS=12\nTARGET_MIN=48\nTARGET_MAX=62\n');
  console.log('  + input/timing.conf (기본값 — 목표 길이 48~62s)');
}
if (!existsSync(join(IN, 'readings.tsv'))) {
  writeFileSync(join(IN, 'readings.tsv'), '');
  console.log('  + input/readings.tsv (빈 파일 — 02 가 미등록 표기를 알려주면 채운다)');
}
if (!existsSync(join(IN, 'speakers.tsv'))) {
  // ⚠️ macOS 는 **미설치 음성도 목록에 표시한다.** 실제로 합성해 보고 파일 크기로 거른다(§10).
  let voices = [];
  try {
    voices = execSync("say -v '?'", { encoding: 'utf8' }).split('\n')
      .filter(l => /\bko_KR\b/.test(l)).map(l => l.split(/\s{2,}|\t/)[0].replace(/\s*\(.*\)$/, '').trim())
      .filter(Boolean);
  } catch {}
  let voice = null;
  for (const v of voices) {
    const t = join(tmpdir(), `v_${Date.now()}.aiff`);
    try {
      execSync(`say -v ${JSON.stringify(v)} -o ${JSON.stringify(t)} "테스트" < /dev/null`, { stdio: 'ignore' });
      if (statSync(t).size > 20000) { voice = v; }
      rmSync(t, { force: true });
    } catch {}
    if (voice) break;
  }
  if (!voice) {
    console.log('  ⚠️ 설치된 ko_KR 음성을 찾지 못했습니다 → input/speakers.tsv 를 직접 작성하세요');
    console.log('     시스템 설정 > 손쉬운 사용 > 음성 콘텐츠 에서 한국어 음성을 받으세요 (§1)');
  } else {
    // 음성 하나를 **피치로만** 갈라 두 화자를 만든다(§4).
    // ⚠️ rate 로 차이를 주지 말 것. `say -r` 은 이산 양자화라 미세 조정이 안 되고(§10),
    //    200 으로 낮추면 발화가 8초 길어져 목표 범위를 벗어난다(실측 54s → 62s).
    //    라벨은 화자 ID 를 쓴다 — build/track_<라벨>.wav 파일명에 들어가므로 ASCII 가 안전하다.
    const rows = Object.entries(cast.speakers).map(([sid], i) =>
      [sid, voice, 250, i === 0 ? 0.86 : 1.16, sid].join('\t'));
    writeFileSync(join(IN, 'speakers.tsv'), rows.join('\n') + '\n');
    console.log(`  + input/speakers.tsv (음성 ${voice} 를 피치로 분리 — 필요하면 조정)`);
  }
}
let bad = 0;
for (const [sid, s] of Object.entries(cast.speakers)) {
  const ok = s.back && s.neutral;
  if (!ok) bad++;
  console.log(`  ${sid}  이름=${s.name}  앞모습[${Object.keys(s.front).join(', ')}]  기본=${s.neutral || '✗'}  뒤통수=${s.back ? 'O' : '✗'}`);
}
if (cast.scenes.length) console.log(`  장면 ${cast.scenes.length}개`);
if (bad || cast.mode.startsWith('flat')) {
  console.log('\n⚠️ 확인할 것:');
  console.log('   · speakers[].name 이 **대본 docx 의 화자 이름과 정확히 같은가**');
  console.log('   · 화자마다 기본 표정과 뒤통수가 하나씩 잡혔는가');
  console.log('   · 앞모습 목록에 뒤통수/장면이 섞여 들어가지 않았는가');
}
