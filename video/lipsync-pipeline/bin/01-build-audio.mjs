#!/usr/bin/env node
/**
 * 01-build-audio — 대본 TSV → 줄별 오디오 + 타임라인 + 화자별 풀길이 트랙
 *
 * 입력:  input/script.tsv    n \t speaker \t gap_after \t text
 *        input/speakers.tsv  speaker \t voice \t rate \t pitch \t label
 *        input/timing.conf   COLD_OPEN / OUTRO / MOUTH_FPS / TARGET_MIN / TARGET_MAX
 * 출력:  build/lines/l<n>.wav        줄별 오디오
 *        build/timeline.json         전체 타임라인(입모양 생성기의 입력)
 *        build/track_<speaker>.wav   화자별 풀길이 트랙(립싱크 모델 입력)
 *        build/master.wav            믹스 마스터(최종 합성용)
 *
 * 이 스크립트는 대본 내용에 의존하지 않는다. TSV만 갈아끼우면 그대로 동작한다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'input');
const BUILD = join(ROOT, 'build');

// ── ffmpeg/ffprobe 해석: 시스템 우선, 없으면 npm static ─────────────
function resolveBin(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {}
  const pkg = name === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static';
  const mod = join(ROOT, 'node_modules', pkg);
  if (!existsSync(mod)) throw new Error(`${name} 없음. 'npm i ffmpeg-static ffprobe-static' 실행 필요`);
  if (name === 'ffmpeg') return join(mod, 'ffmpeg');
  return join(mod, 'bin', process.platform, process.arch, 'ffprobe');
}
const FFMPEG = resolveBin('ffmpeg');
const FFPROBE = resolveBin('ffprobe');

const sh = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

function tsv(file) {
  return readFileSync(join(IN, file), 'utf8')
    .split('\n').filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('\t'));
}
const conf = Object.fromEntries(
  readFileSync(join(IN, 'timing.conf'), 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const [k, v] = l.split('='); return [k.trim(), parseFloat(v)]; })
);

const speakers = new Map(tsv('speakers.tsv').map(([id, voice, rate, pitch, label]) =>
  [id, { id, voice, rate: +rate, pitch: +pitch, label }]));
// 5번째 열 bg 는 선택. 나레이션 모드에서 줄마다 배경을 바꿀 때 쓴다.
const lines = tsv('script.tsv').map(([n, spk, gap, text, bg, card]) =>
  ({ n, spk, gap: +gap, text, bg: bg?.trim() || null, card: card?.trim() || null }));

rmSync(join(BUILD, 'lines'), { recursive: true, force: true });
mkdirSync(join(BUILD, 'lines'), { recursive: true });

const dur = f => parseFloat(sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());

// ── 1) 줄별 TTS 합성 ────────────────────────────────────────────────
// macOS `say`는 stdin을 읽으므로 stdio를 반드시 격리한다. (미격리 시 루프 입력이 잠식됨)
console.log('── 줄별 TTS 합성 ──');
for (const L of lines) {
  const s = speakers.get(L.spk);
  if (!s) throw new Error(`화자 정의 없음: ${L.spk}`);
  const aiff = join(BUILD, 'lines', `raw${L.n}.aiff`);
  const wav = join(BUILD, 'lines', `l${L.n}.wav`);
  sh('say', ['-v', s.voice, '-r', String(s.rate), '-o', aiff, L.text]);

  // 피치 시프트: asetrate로 내리고 atempo로 속도 복원 → 길이 보존, 음색만 변경
  //
  // ⚠️ 반드시 먼저 aresample=44100 을 통과시킨다.
  // macOS `say -o *.aiff` 는 22050Hz 로 출력한다. 그 위에 asetrate=44100*p 를 걸면
  // 기준 레이트가 어긋나 (44100/22050)*p = 2p 배로 재생돼 길이가 절반이 되고
  // 피치가 내려가는 대신 올라간다. 알려진 레이트로 정규화한 뒤 적용해야 한다.
  const af = s.pitch === 1
    ? 'aresample=44100'
    : `aresample=44100,asetrate=44100*${s.pitch},aresample=44100,atempo=${(1 / s.pitch).toFixed(6)}`;
  sh(FFMPEG, ['-y', '-nostdin', '-v', 'error', '-i', aiff, '-af', af, '-ar', '44100', '-ac', '1', wav]);

  L.dur = dur(wav);
  L.file = wav;
  // 빈 오디오 감지: macOS는 미설치 음성도 목록에 표시하고 무음 파일을 생성한다
  if (L.dur < 0.15) throw new Error(
    `l${L.n}: 오디오가 비었습니다(${L.dur}s). 음성 '${s.voice}'가 미설치일 수 있습니다.\n` +
    `  확인: say -v '?' | grep ko_KR  →  시스템 설정 > 손쉬운 사용 > 음성 콘텐츠에서 다운로드`);
  console.log(`  l${L.n} ${L.spk} ${L.dur.toFixed(2)}s  ${L.text.slice(0, 28)}`);
}

// ── 2) 타임라인 계산 ────────────────────────────────────────────────
let t = conf.COLD_OPEN;
for (const L of lines) {
  L.start = +t.toFixed(3);
  L.end = +(t + L.dur).toFixed(3);
  t = L.end + L.gap;
}
const total = +(t + conf.OUTRO).toFixed(3);

const timeline = {
  total,
  mouthFps: conf.MOUTH_FPS,
  coldOpen: conf.COLD_OPEN,
  outro: conf.OUTRO,
  speakers: [...speakers.values()],
  lines,
};
mkdirSync(BUILD, { recursive: true });
const writeTimeline = () => writeFileSync(join(BUILD, 'timeline.json'), JSON.stringify({
  ...timeline,
  lines: lines.map(({ n, spk, text, dur, start, end, gap, bg, card, compactStart }) =>
    ({ n, spk, text, dur, start, end, gap, bg, card, compactStart })),
}, null, 2));
writeTimeline();

// ── 3) 화자별 풀길이 트랙 ───────────────────────────────────────────
// 립싱크 모델은 프레임당 얼굴 1개만 처리한다. 캐릭터를 각각 따로 렌더해야 하므로
// 화자마다 "자기 대사만 들리고 나머지는 무음"인 전체 길이 트랙이 필요하다.
console.log('── 화자별 풀길이 트랙 ──');
for (const s of speakers.values()) {
  const mine = lines.filter(L => L.spk === s.id);
  const args = ['-y', '-nostdin', '-v', 'error',
    '-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=mono'];
  mine.forEach(L => args.push('-i', L.file));
  const parts = mine.map((L, i) => `[${i + 1}:a]adelay=${Math.round(L.start * 1000)}[d${i}]`);
  const mixIn = ['[0:a]', ...mine.map((_, i) => `[d${i}]`)].join('');
  args.push('-filter_complex',
    `${parts.join(';')};${mixIn}amix=inputs=${mine.length + 1}:normalize=0[out]`,
    '-map', '[out]', '-t', String(total), '-ar', '44100', '-ac', '1',
    join(BUILD, `track_${s.id}.wav`));
  sh(FFMPEG, args);
  console.log(`  track_${s.id}.wav (${s.label}) ${mine.length}줄`);
}

// ── 3.5) 화자별 "압축 트랙" ─────────────────────────────────────────
// 생성형 립싱크 서비스는 길이 제한이 있다(Flyworks 무료 티어 45초).
// 무음 구간을 빼고 자기 대사만 이어붙이면 길이가 크게 줄어 한 번에 들어간다.
// 각 줄이 압축 트랙 안에서 어디에 있는지(compactStart)를 기록해 두면
// 합성 단계에서 원래 타임라인 위치로 되돌릴 수 있다.
const COMPACT_PAD = 0.12;
for (const s of speakers.values()) {
  const mine = lines.filter(L => L.spk === s.id);
  if (!mine.length) continue;
  let off = 0;
  const parts = [];
  mine.forEach((L, i) => {
    L.compactStart = +off.toFixed(3);
    parts.push(L.file);
    off += L.dur + (i < mine.length - 1 ? COMPACT_PAD : 0);
  });
  const listFile = join(BUILD, `compact_${s.id}.txt`);
  writeFileSync(listFile, parts.map((p, i) =>
    `file '${p}'` + (i < parts.length - 1 ? `\noutpoint ${(dur(p) + COMPACT_PAD).toFixed(3)}` : '')).join('\n') + '\n');
  // concat демuxer 는 무음 삽입을 못하므로 adelay 로 직접 배치한다
  const args = ['-y', '-nostdin', '-v', 'error',
    '-f', 'lavfi', '-t', off.toFixed(3), '-i', 'anullsrc=r=44100:cl=mono'];
  mine.forEach(L => args.push('-i', L.file));
  const parts2 = mine.map((L, i) => `[${i + 1}:a]adelay=${Math.round(L.compactStart * 1000)}[d${i}]`);
  args.push('-filter_complex',
    `${parts2.join(';')};${['[0:a]', ...mine.map((_, i) => `[d${i}]`)].join('')}amix=inputs=${mine.length + 1}:normalize=0[out]`,
    '-map', '[out]', '-t', off.toFixed(3), '-ar', '44100', '-ac', '1',
    join(BUILD, `compact_${s.id}.wav`));
  sh(FFMPEG, args);
  console.log(`  compact_${s.id}.wav ${off.toFixed(2)}s (원본 ${total.toFixed(2)}s → ${(off / total * 100).toFixed(0)}%)`);
}

// ── 4) 마스터 믹스 ──────────────────────────────────────────────────
const tracks = [...speakers.values()].map(s => join(BUILD, `track_${s.id}.wav`));
const mArgs = ['-y', '-nostdin', '-v', 'error'];
tracks.forEach(f => mArgs.push('-i', f));
mArgs.push('-filter_complex', `amix=inputs=${tracks.length}:normalize=0,alimiter=limit=0.95[out]`,
  '-map', '[out]', '-ar', '44100', '-ac', '2', join(BUILD, 'master.wav'));
sh(FFMPEG, mArgs);

writeTimeline();   // compactStart 반영

// ── 5) 길이 검증 ────────────────────────────────────────────────────
const speech = lines.reduce((a, L) => a + L.dur, 0);
console.log(`\n발화 ${speech.toFixed(2)}s / 총 ${total.toFixed(2)}s (목표 ${conf.TARGET_MIN}~${conf.TARGET_MAX}s)`);
if (total < conf.TARGET_MIN || total > conf.TARGET_MAX) {
  const mid = (conf.TARGET_MIN + conf.TARGET_MAX) / 2;
  const gapTotal = lines.reduce((a, L) => a + L.gap, 0);
  console.log(`⚠️  목표 범위 밖. 보정 방법 (권장 순서):`);
  console.log(`    1. gap 총합 ${gapTotal.toFixed(2)}s → ${(gapTotal + mid - total).toFixed(2)}s 로 조정 (${(mid - total > 0 ? '+' : '')}${(mid - total).toFixed(2)}s)`);
  console.log(`       줄 수 ${lines.length}개에 균등 배분하면 줄당 ${((mid - total) / lines.length).toFixed(2)}s`);
  console.log(`    2. COLD_OPEN/OUTRO 조정 (현재 ${conf.COLD_OPEN}s / ${conf.OUTRO}s)`);
  console.log(`    3. speakers.tsv 의 rate — 단 macOS \`say -r\` 은 이산 양자화된다.`);
  console.log(`       (예: 128과 150이 동일 길이) 미세 조정 불가, 배율 100/150/200/250 단위로만 유효`);
  process.exitCode = 2;
} else {
  console.log('✅ 목표 범위 내');
}
