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

const PLATFORM = process.platform;

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

// ── 플랫폼별 TTS 엔진 (process.platform 감지) ───────────────────────
// 산출물 규약은 OS 와 무관하다. 엔진은 "주어진 텍스트를 주어진 속도로 읽은 base
// 오디오 파일 하나"만 만든다. 피치 시프트/길이 계산 등 다운스트림(§4)은 그대로다.
//   darwin : say (기존과 100% 동일 — 회귀 없음)
//   win32  : PowerShell + System.Speech (SAPI). 한국어 음성(예: 'Microsoft Heami Desktop') 선택
//   linux  : piper(모델 지정 시) → 없으면 espeak-ng -v ko (최소 요건)
// 어느 엔진도 없으면 OS별 설치 안내와 함께 즉시 중단한다(무음 파일 생성 금지).
function hasCmd(cmd) {
  try {
    execFileSync(PLATFORM === 'win32' ? 'where' : 'which', [cmd],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

// wpm(=macOS `say -r` 기준) → 각 엔진 속도로의 문서화된 근사 매핑.
// 엔진마다 속도 단위가 달라 완전 일치는 불가능하다. 시각 파이프라인은 동일하고
// 오디오 길이만 달라질 수 있으므로 목표 범위(§6)를 벗어나면 01 이 보정 지시를 낸다.
const ESPEAK_BIN = hasCmd('espeak-ng') ? 'espeak-ng' : (hasCmd('espeak') ? 'espeak' : 'espeak-ng');
const rateMap = {
  // espeak `-s` 는 words/min. 한국어는 같은 수치에서 say 보다 빠르게 들려 0.7 배로 근사.
  espeak: wpm => Math.max(80, Math.min(450, Math.round(wpm * 0.7))),
  // piper `--length_scale` 은 작을수록 빠름. 기준 200wpm = 1.0.
  piper: wpm => +(200 / Math.max(1, wpm)).toFixed(3),
  // SAPI Rate 는 정수 -10..10. 기준 200wpm = 0, 25wpm 당 1 단계.
  sapi: wpm => Math.max(-10, Math.min(10, Math.round((wpm - 200) / 25))),
};

function pickEngine() {
  if (process.env.TTS_ENGINE) return process.env.TTS_ENGINE;   // 강제 지정(테스트용)
  if (PLATFORM === 'darwin') return 'say';
  if (PLATFORM === 'win32') return 'sapi';
  if (hasCmd('piper') && (process.env.PIPER_MODEL || process.env.PIPER_VOICE)) return 'piper';
  if (hasCmd('espeak-ng') || hasCmd('espeak')) return 'espeak';
  return null;
}
const ENGINE = pickEngine();
if (!ENGINE) {
  const help = {
    darwin: "macOS: 내장 `say` 명령이 필요합니다.",
    win32: "Windows: System.Speech(SAPI)를 쓰는 내장 PowerShell 과 한국어 음성(예: 'Microsoft Heami Desktop')이 필요합니다.",
    linux: "Linux/클라우드: `espeak-ng`(최소) 또는 `piper`+한국어 모델(.onnx)이 필요합니다.\n     예) sudo apt-get install -y espeak-ng",
  }[PLATFORM] || "이 OS에서 쓸 수 있는 TTS 엔진을 찾지 못했습니다.";
  throw new Error(`TTS 엔진을 찾지 못했습니다.\n  ${help}\n  (환경변수 TTS_ENGINE=say|sapi|espeak|piper 로 강제 지정 가능)`);
}

const psStr = v => "'" + String(v).replace(/'/g, "''") + "'";

// SAPI(win32): PowerShell 로 WAV 를 직접 쓴다. 한국어/따옴표 인코딩 문제를 피하려고
// 대사는 UTF-8 파일로 넘기고, 스크립트도 UTF-8(BOM) .ps1 로 저장해 실행한다.
function synthSapi(s, text, outNoExt) {
  const wav = `${outNoExt}.wav`, txtFile = `${outNoExt}.txt`, ps1File = `${outNoExt}.ps1`;
  writeFileSync(txtFile, text, 'utf8');
  const wantVoice = process.env.SAPI_VOICE || 'Microsoft Heami Desktop';
  const rate = rateMap.sapi(s.rate);
  const ps = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Speech;",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    `$want = ${psStr(wantVoice)};`,
    "$sel = $null;",
    "foreach ($v in $synth.GetInstalledVoices()) { if ($v.Enabled -and $v.VoiceInfo.Name -eq $want) { $sel = $v.VoiceInfo.Name } }",
    "if (-not $sel) { foreach ($v in $synth.GetInstalledVoices()) { if ($v.Enabled -and $v.VoiceInfo.Culture.Name -eq 'ko-KR') { $sel = $v.VoiceInfo.Name; break } } }",
    "if ($sel) { $synth.SelectVoice($sel) }",
    `$synth.Rate = ${rate};`,
    `$synth.SetOutputToWaveFile(${psStr(wav)});`,
    `$txt = [System.IO.File]::ReadAllText(${psStr(txtFile)}, [System.Text.Encoding]::UTF8);`,
    "$synth.Speak($txt);",
    "$synth.Dispose();",
  ].join('\n');
  writeFileSync(ps1File, '\uFEFF' + ps, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1File],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return wav;
}

// 텍스트를 base 오디오로 합성하고 그 경로를 돌려준다. outNoExt 는 확장자 없는 경로.
function synthBase(s, text, outNoExt) {
  if (ENGINE === 'say') {
    const aiff = `${outNoExt}.aiff`;
    // macOS `say` 는 stdin 을 읽으므로 sh 가 stdin 을 격리한다(기존 동작 보존).
    sh('say', ['-v', s.voice, '-r', String(s.rate), '-o', aiff, text]);
    return aiff;
  }
  if (ENGINE === 'espeak') {
    const wav = `${outNoExt}.wav`;
    sh(ESPEAK_BIN, ['-v', 'ko', '-s', String(rateMap.espeak(s.rate)), '-w', wav, text]);
    return wav;
  }
  if (ENGINE === 'piper') {
    const wav = `${outNoExt}.wav`;
    const model = process.env.PIPER_MODEL || process.env.PIPER_VOICE;
    if (!model) throw new Error("piper 엔진에는 PIPER_MODEL(한국어 .onnx 모델 경로)이 필요합니다.");
    // piper 는 대사를 stdin 으로 받는다 → 루프 stdin 잠식이 없다.
    execFileSync('piper', ['--model', model, '--output_file', wav,
      '--length_scale', String(rateMap.piper(s.rate))],
      { input: text, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8' });
    return wav;
  }
  if (ENGINE === 'sapi') return synthSapi(s, text, outNoExt);
  throw new Error(`알 수 없는 TTS 엔진: ${ENGINE}`);
}

function emptyAudioMsg(L, s) {
  const per = {
    say: `음성 '${s.voice}'가 미설치일 수 있습니다.\n  확인: say -v '?' | grep ko_KR  →  시스템 설정 > 손쉬운 사용 > 음성 콘텐츠에서 다운로드`,
    espeak: `espeak-ng 한국어 데이터가 설치돼 있는지 확인하세요 (apt-get install -y espeak-ng espeak-ng-data).`,
    piper: `PIPER_MODEL 이 유효한 한국어 모델(.onnx)을 가리키는지 확인하세요.`,
    sapi: `한국어 SAPI 음성(예: 'Microsoft Heami Desktop')이 설치·활성화돼 있는지 확인하세요.`,
  }[ENGINE] || '';
  return `l${L.n}: 오디오가 비었습니다(${L.dur}s). ${per}`;
}

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
// TTS 엔진은 base 오디오만 만든다(§4). 피치는 아래에서 ffmpeg 로 건다.
console.log(`── 줄별 TTS 합성 (엔진 ${ENGINE}, platform ${PLATFORM}) ──`);
for (const L of lines) {
  const s = speakers.get(L.spk);
  if (!s) throw new Error(`화자 정의 없음: ${L.spk}`);
  const base = synthBase(s, L.text, join(BUILD, 'lines', `raw${L.n}`));
  const wav = join(BUILD, 'lines', `l${L.n}.wav`);

  // 피치 시프트: asetrate로 내리고 atempo로 속도 복원 → 길이 보존, 음색만 변경
  //
  // ⚠️ 반드시 먼저 aresample=44100 을 통과시킨다.
  // macOS `say -o *.aiff`(그리고 espeak-ng -w)는 22050Hz 로 출력한다. 그 위에
  // asetrate=44100*p 를 걸면 기준 레이트가 어긋나 (44100/22050)*p = 2p 배로 재생돼
  // 길이가 절반이 되고 피치가 반대로 올라간다. 알려진 레이트로 정규화한 뒤 적용해야 한다.
  const af = s.pitch === 1
    ? 'aresample=44100'
    : `aresample=44100,asetrate=44100*${s.pitch},aresample=44100,atempo=${(1 / s.pitch).toFixed(6)}`;
  sh(FFMPEG, ['-y', '-nostdin', '-v', 'error', '-i', base, '-af', af, '-ar', '44100', '-ac', '1', wav]);

  L.dur = dur(wav);
  L.file = wav;
  // 빈 오디오 감지: 무음 파일을 조용히 흘려보내지 않고 OS별 원인을 알린다.
  if (L.dur < 0.15) throw new Error(emptyAudioMsg(L, s));
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
  console.log(`    3. speakers.tsv 의 rate — 엔진별로 단위가 다르다(§4).`);
  console.log(`       macOS \`say -r\` 은 이산 양자화(예: 128과 150이 동일 길이, 100/150/200/250 단위).`);
  console.log(`       espeak-ng/piper/SAPI 는 근사 매핑되므로 총길이가 macOS 와 다를 수 있다.`);
  process.exitCode = 2;
} else {
  console.log('✅ 목표 범위 내');
}
