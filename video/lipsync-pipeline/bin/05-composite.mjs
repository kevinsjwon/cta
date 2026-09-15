#!/usr/bin/env node
/**
 * 05-composite — 생성형 립싱크 결과물을 최종 영상으로 합성
 *
 * 생성형 립싱크 툴은 "말하는 캐릭터 클립"까지만 만든다. 컷 편집·배경 전환·
 * 자막·오디오 재결합은 항상 이 단계가 필요하다. (§4 참조)
 *
 * MODE=dialogue
 *   두 개의 완성 프레임 영상(화자별)을 숏 스케줄대로 잘라 붙인다.
 *   각 영상은 자기 화자의 트랙만 들어 있으므로 오디오는 master.wav 로 교체한다.
 *     --clip P=<파일> --clip R=<파일>
 *
 * MODE=narration
 *   그린스크린 영상을 크로마키로 뽑아 대사별 배경 위에 올린다.
 *     --green <파일>
 *   워터마크가 상단에 박히므로 --croptop 으로 잘라낸다.
 *
 * 공통: build/timeline.json 의 타이밍을 그대로 따르므로 결정론 렌더와 컷이 일치한다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build'), OUT = join(ROOT, 'output');
const TMP = join(BUILD, 'comp');
mkdirSync(TMP, { recursive: true });

const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const run = a => execFileSync(FFMPEG, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', ...a], { stdio: 'inherit' });

const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const argAll = k => args.reduce((a, v, i) => (v === `--${k}` ? [...a, args[i + 1]] : a), []);

const MODE = process.env.MODE || 'dialogue';
const ASPECT = process.env.ASPECT || '9:16';
const [OW, OH] = ASPECT === '16:9' ? [1920, 1080] : [1080, 1920];
const TAG = ASPECT === '16:9' ? 'wide' : 'tall';
const PRE_ROLL = 0.18;
const GREEN = '0x00B140';

const tl = JSON.parse(readFileSync(join(BUILD, 'timeline.json'), 'utf8'));
const assPath = join(BUILD, 'captions.ass');
const name = arg('name') || `composite_${MODE}`;
const outFile = join(OUT, `${name}.mp4`);

// ── 숏 구간 계산 (03-render 와 동일한 규칙) ─────────────────────────
function segments() {
  const segs = [];
  let cur = null;
  for (const L of tl.lines) {
    const key = MODE === 'narration' ? L.bg : L.spk;
    const start = Math.max(0, L.start - PRE_ROLL);
    if (!cur || cur.key !== key) { if (cur) cur.end = start; cur = { key, start }; segs.push(cur); }
  }
  if (segs.length) { segs[0].start = 0; segs[segs.length - 1].end = tl.total; }
  for (let i = 0; i < segs.length - 1; i++) if (segs[i].end == null) segs[i].end = segs[i + 1].start;
  return segs.filter(s => s.end > s.start + 0.04);
}
const segs = segments();
console.log(`${MODE} / 구간 ${segs.length}개 / 총 ${tl.total}s`);

if (MODE === 'ots_compact') {
  // ── 오버더숄더 + 압축 트랙 + 전경 직접 합성 ─────────────────────
  //
  // ⚠️ 생성형 립싱크에 "완성 프레임"을 넣으면 입만이 아니라 **프레임 전체를
  // 재생성**한다. 전경에 놓인 정적 요소(청자 뒷모습)가 매 프레임 다른 모양으로
  // 뭉개지고, 추상적인 형체는 손·다른 물체로 해석되기도 한다(실측).
  //
  // 그래서 화자만 그린스크린으로 립싱크시키고, 배경과 전경은 여기서 얹는다.
  // 전경이 이미지 파일이므로 구조적으로 변형이 불가능하다.
  //
  //   --green <화자>=<파일>   그린스크린 립싱크 클립
  //   --bg <파일>             배경 플레이트
  //   --back <화자>=<파일>    그 화자의 뒷모습 PNG(알파)
  const greens = Object.fromEntries(argAll('green').map(s => { const i = s.indexOf('='); return [s.slice(0, i), resolve(s.slice(i + 1))]; }));
  const backs = Object.fromEntries(argAll('back').map(s => { const i = s.indexOf('='); return [s.slice(0, i), resolve(s.slice(i + 1))]; }));
  const bgImg = resolve(arg('bg'));
  const cropTop = +(arg('croptop') || 0.06);
  // 컷아웃에 남은 흰 테두리·하단 흰 띠를 잘라낸다 (체커 제거 잔여물)
  const cropBottom = +(arg('cropbottom') || 0);
  const cropLeft = +(arg('cropleft') || 0);
  const cropRight = +(arg('cropright') || 0);
  const keepW = 1 - cropLeft - cropRight, keepH = 1 - cropTop - cropBottom;

  // ⚠️ 키 색을 하드코딩하면 안 된다. Flyworks 는 재인코딩하면서 그린을 이동시킨다
  // (입력 rgb(0,177,64) → 출력 rgb(0,165,58) 실측). 클립 모서리에서 실제 색을 읽는다.
  const keyOf = file => {
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.5', '-i', file,
      '-frames:v', '1', '-vf', 'crop=8:8:4:4', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { maxBuffer: 1 << 20 });
    const hex = '0x' + [raw[0], raw[1], raw[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    console.log(`  키 색 자동검출 ${file.split('/').pop()} → ${hex}`);
    return hex;
  };
  const keyColor = Object.fromEntries(Object.entries(greens).map(([k, v]) => [k, keyOf(v)]));

  // 제공된 원본 대화장면의 구도를 따른다: 화자는 화면 중앙(살짝 왼쪽),
  // 청자 뒷모습은 오른쪽 아래에서 프레임 밖으로 잘린다.
  const SPK_H = +(arg('spkh') || 0.56), SPK_X = +(arg('spkx') || 0.46), SPK_B = +(arg('spkb') || 0.82);
  const FG_H = +(arg('fgh') || 0.46), FG_X = +(arg('fgx') || 0.80), FG_B = +(arg('fgb') || 1.06);
  const FEATHER = +(arg('feather') || 0);   // 레이어 가장자리 페더 폭(px). 기본 0 — 흐릿해 보이므로 쓰지 않는다
  // 책상 전경: 캐릭터 하단 절단면을 가려 "책상 뒤에 앉아 있는" 현실적인 배치를 만든다
  const deskImg = arg('desk') ? resolve(arg('desk')) : null;
  const DESK_H = +(arg('deskh') || 0.30), DESK_B = +(arg('deskb') || 1.0);
  // 워터마크 제거 박스: --delogo <화자>=x:y:w:h  (06-find-watermark.mjs 로 좌표를 얻는다)
  const delogo = Object.fromEntries(argAll('delogo').map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));

  const enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p'];
  const parts = [];
  let cursor = 0, idx = 0;

  // ⚠️ 대사 사이 공백을 **정지 프레임**으로 채우면 "영상 → 사진 → 영상" 으로 튄다.
  // 압축 트랙에는 줄 사이에 COMPACT_PAD(0.12s) 만큼의 무음 구간이 있으므로,
  // 그 구간을 setpts 로 **초저속 재생**해 공백 길이를 채운다. 입이 닫힌 상태의
  // 미세한 움직임이 이어져 컷이 튀지 않는다.
  const seg = (L, from, dur, slowFrom) => {
    const listener = Object.keys(backs).find(k => k !== L.spk);
    const p = join(TMP, `o${String(idx++).padStart(2, '0')}.mp4`);
    const srcDur = slowFrom ? slowFrom.src : dur;
    const ptsK = slowFrom ? (dur / slowFrom.src) : 1;
    const a = ['-ss', String(from.toFixed(3)), '-t', String(srcDur.toFixed(3))];
    a.push('-i', greens[L.spk], '-loop', '1', '-i', bgImg, '-loop', '1', '-i', backs[listener]);
    if (deskImg) a.push('-loop', '1', '-i', deskImg);
    const dl = delogo[L.spk] ? `delogo=x=${delogo[L.spk].split(':')[0]}:y=${delogo[L.spk].split(':')[1]}:w=${delogo[L.spk].split(':')[2]}:h=${delogo[L.spk].split(':')[3]},` : '';
    const chain =
      `[0:v]${dl}crop=iw*${keepW.toFixed(4)}:ih*${keepH.toFixed(4)}:iw*${cropLeft.toFixed(4)}:ih*${cropTop.toFixed(4)},` +
      `scale=-1:${Math.round(SPK_H * OH)},format=rgba,colorkey=${keyColor[L.spk]}:0.22:0.02,despill=type=green` +
      // 클로즈업 컷아웃은 어깨·귀가 원본 프레임에 잘려 있다. 축소해 쓰면 그 절단면이
      // 직선으로 드러나므로 레이어 가장자리 알파를 램프로 떨어뜨려 배경에 녹인다.
      (FEATHER > 0 ? `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(alpha(X,Y),140),255,0)*min(1,min(X,W-1-X)/${FEATHER})*min(1,min(Y,H-1-Y)/${FEATHER})',format=rgba` : '') +
      `[k];` +
      `[1:v]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH}[b];` +
      `[2:v]scale=-1:${Math.round(FG_H * OH)}[f];` +
      (deskImg ? `[3:v]scale=${OW}:${Math.round(DESK_H * OH)}[d];` : '') +
      `[b][k]overlay=${Math.round(OW * SPK_X)}-w/2:${Math.round(OH * SPK_B)}-h[o1];` +
      // 순서: 배경 → 화자 → 책상(화자 하단 절단면을 가림) → 청자 뒷모습(가장 앞)
      (deskImg ? `[o1][d]overlay=0:${Math.round(OH * DESK_B)}-h[o2];` : `[o1]null[o2];`) +
      `[o2][f]overlay=${Math.round(OW * FG_X)}-w/2:${Math.round(OH * FG_B)}-h` +
      (ptsK !== 1 ? `,setpts=${ptsK.toFixed(4)}*PTS` : '') + `,fps=24[v]`;
    a.push('-filter_complex', chain, '-map', '[v]', '-an');
    run([...a, '-t', String(dur.toFixed(3)), ...enc, p]);
    parts.push(p);
  };

  const PAD = 0.12;   // 01-build-audio 의 COMPACT_PAD 와 일치해야 한다
  for (const L of tl.lines) {
    if (!greens[L.spk]) throw new Error(`--green ${L.spk}=<파일> 필요`);
    // 대사 앞 공백: 직전에 말한 사람 화면을 유지하지 않고, 이 줄 화자의 무음 구간을
    // 초저속으로 늘려 채운다 (컷은 공백 시작점에서 한 번만 일어난다)
    if (L.start > cursor + 0.04) {
      const back = Math.min(PAD, L.compactStart);
      seg(L, L.compactStart - back, L.start - cursor, { src: Math.max(0.04, back) });
    }
    seg(L, L.compactStart, L.dur, null);
    cursor = L.end;
    console.log(`  ${L.n} ${L.spk}  ${L.start.toFixed(2)}~${L.end.toFixed(2)}s`);
  }
  if (tl.total > cursor + 0.04) {
    const last = tl.lines[tl.lines.length - 1];
    seg(last, last.compactStart + last.dur - PAD, tl.total - cursor, { src: PAD });
  }

  const list = join(TMP, 'olist.txt');
  writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  const joined = join(TMP, 'ojoined.mp4');
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  run(['-i', joined, '-i', join(BUILD, 'master.wav'),
    '-filter_complex', `[0:v]ass='${assPath.replace(/([:\\])/g, '\\$1')}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile]);

} else if (MODE === 'compact') {
  // ── 압축 트랙 기반 합성 ─────────────────────────────────────────
  // 생성형 립싱크는 길이 제한이 있어 무음을 뺀 "압축 트랙"으로 렌더한다(§01단계).
  // 여기서는 각 줄을 압축 클립의 compactStart 위치에서 잘라 원래 타임라인에 되돌린다.
  //
  //   --clip <키>=<파일>     키는 화자ID 또는 "화자ID:표정"
  //   --pick <표정>=<줄번호,줄번호,...>   표정별로 쓸 클립 지정 (선택)
  //
  // 줄 사이의 무음 구간은 직전 줄의 마지막 프레임을 정지 화면으로 채운다.
  const clips = Object.fromEntries(argAll('clip').map(s => {
    const i = s.indexOf('='); return [s.slice(0, i), resolve(s.slice(i + 1))];
  }));
  // 워터마크 제거: --delogo <클립키>=x:y:w:h (06-find-watermark.mjs 로 좌표를 얻는다)
  const delogo = Object.fromEntries(argAll('delogo').map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));
  const dlOf = L => {
    const d = delogo[`${L.spk}:${L.bg}`] || delogo[L.spk];
    if (!d) return '';
    const [x, y, w, h] = d.split(':');
    return `delogo=x=${x}:y=${y}:w=${w}:h=${h},`;
  };
  const parts = [];
  let cursor = 0, idx = 0;

  // ⚠️ 입력측 -ss 만 쓰면 키프레임 사이에 걸려 0프레임이 나올 수 있다(실측).
  // 1초 앞으로 고속 탐색한 뒤 나머지를 출력측에서 정확히 탐색한다.
  const seekArgs = (file, at, dur) => {
    const pre = Math.max(0, at - 1.0);
    return ['-ss', pre.toFixed(3), '-i', file, '-ss', (at - pre).toFixed(3), '-t', dur.toFixed(3)];
  };

  const clipFor = L => clips[`${L.spk}:${L.bg}`] || clips[L.spk]
    || (() => { throw new Error(`--clip ${L.spk}:${L.bg}=<파일> 또는 --clip ${L.spk}=<파일> 필요`); })();

  // ── 표정별 색채 정규화 ────────────────────────────────────────────
  // 표정 원본 이미지끼리 밝기가 다르고(실측: 경고가 기본/설명보다 +17),
  // Flyworks 가 클립마다 색을 또 다르게 이동시킨다. 그대로 이어붙이면
  // 표정이 바뀔 때 캐릭터 색이 튄다. 기준 클립에 맞춰 채널 게인을 건다.
  const meanOf = file => {
    const [w, h] = execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe') === FFMPEG
      ? FFMPEG : join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe'),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' }).trim().split('x').map(Number);
    let sr = 0, sg = 0, sb = 0, qr = 0, qg = 0, qb = 0, n = 0;
    for (const t of ['1', '3', '6', '10', '15', '20', '25', '30', '35']) {
      let px;
      try {
        px = execFileSync(FFMPEG, ['-v', 'error', '-ss', t, '-i', file, '-frames:v', '1',
          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: w * h * 3 + 4096 });
      } catch { continue; }
      // ⚠️ 클립보다 뒤 시각을 샘플하면 빈 버퍼가 돌아온다. 그대로 읽으면 NaN 이 된다.
      if (!px || px.length < w * h * 3) continue;
      const x0 = (w * 0.30) | 0, x1 = (w * 0.70) | 0, y0 = (h * 0.30) | 0, y1 = (h * 0.65) | 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const o = (y * w + x) * 3;
        const r = px[o], g = px[o + 1], b = px[o + 2];
        sr += r; sg += g; sb += b; qr += r * r; qg += g * g; qb += b * b; n++;
      }
    }
    if (!n) return null;
    const mr = sr / n, mg = sg / n, mb = sb / n;
    const sd = (q, m) => Math.max(1, Math.sqrt(Math.max(0, q / n - m * m)));
    return { m: [mr, mg, mb], s: [sd(qr, mr), sd(qg, mg), sd(qb, mb)] };
  };
  // 기준은 **캐릭터마다** 따로 잡는다. 다른 캐릭터에 맞추면 색이 엉뚱해진다.
  //   --colormatch N:설명 --colormatch T:기본
  const refKeys = argAll('colormatch');
  const norm = {};
  for (const refKey of refKeys) {
    const spk = refKey.split(':')[0];
    const ref = meanOf(clips[refKey]);
    if (!ref) { console.log(`  색정규화 기준 ${refKey}: 측정 실패 — 건너뜀`); continue; }
    for (const [k, f] of Object.entries(clips)) {
      if (k.split(':')[0] !== spk) continue;          // 같은 화자만
      const c = meanOf(f);
      if (!c) continue;
      // 평균만 맞추면(게인) **대비 차이가 남아** 표정이 바뀔 때 색이 튄다.
      // 평균 + 표준편차를 함께 맞추는 선형 정규화를 건다:
      //   out = (in - m) * (refS / s) + refM
      const sc = [0, 1, 2].map(i => Math.min(1.5, Math.max(0.7, ref.s[i] / c.s[i])));
      norm[k] = { sc, m: c.m, rm: ref.m };
      console.log(`  색정규화 ${k}: 평균(${c.m.map(v => v.toFixed(1)).join(',')}) 대비(${c.s.map(v => v.toFixed(1)).join(',')})` +
        ` → 배율 ${sc.map(v => v.toFixed(3)).join('/')}`);
    }
  }
  const gainFilterFor = L => {
    const k = clips[`${L.spk}:${L.bg}`] ? `${L.spk}:${L.bg}` : L.spk;
    const p = norm[k];
    if (!p) return '';
    const e = i => `clip((val-${p.m[i].toFixed(2)})*${p.sc[i].toFixed(4)}+${p.rm[i].toFixed(2)}\\,0\\,255)`;
    return `lutrgb=r='${e(0)}':g='${e(1)}':b='${e(2)}',`;
  };

  const enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p'];
  // croptop: Flyworks 워터마크가 상단에 박히므로 살짝 잘라내고 다시 채운다
  const ct = +(arg('croptop') || 0);
  const pre = ct > 0 ? `crop=iw:ih*${(1 - ct).toFixed(4)}:0:ih*${ct.toFixed(4)},` : '';
  // ⚠️ fps=24 는 반드시 setpts **뒤**에 와야 한다. 앞에 두면 늘려도 프레임이 안 늘어난다
  // (0.04s=1프레임을 0.46s 로 늘려도 여전히 1프레임 → xfade 가 입력을 기다리며 멈춘다).
  const scaleNF = `${pre}scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH}`;
  const scale = `${scaleNF},fps=24`;

  // ⚠️ 정지 프레임으로 공백을 채우면 "영상 → 사진 → 영상" 으로 튄다.
  // 압축 트랙의 무음 패딩(COMPACT_PAD)을 초저속 재생해 이어 붙인다.
  const PAD = 0.12;
  const XF = +(arg('xfade') || 0);   // 표정/화자가 바뀔 때 크로스페이드 길이(초)
  let prevLine = null;
  for (const L of tl.lines) {
    const src = clipFor(L);
    if (L.start > cursor + 0.04) {
      const need = L.start - cursor;
      const back = Math.max(0.04, Math.min(PAD, L.compactStart));
      const p = join(TMP, `c${String(idx++).padStart(2, '0')}_gap.mp4`);
      const changed = prevLine && clipFor(prevLine) !== src;

      if (changed && XF > 0) {
        // 표정이 바뀔 때 하드컷하면 얼굴이 튄다. 무음 공백에서 크로스페이드한다.
        // 한 번의 ffmpeg 호출로 처리한다 — 임시 파일을 거치면 짧은 구간에서
        // 탐색이 어긋나 0~1프레임짜리 입력이 만들어지고 xfade 가 무한 대기한다.
        const prevSrc = clipFor(prevLine);
        const aAt = Math.max(0, prevLine.compactStart + prevLine.dur - PAD);
        const aDur = Math.max(0.04, (prevLine.compactStart + prevLine.dur) - aAt);
        const bAt = Math.max(0, L.compactStart - PAD);
        const bDur = Math.max(0.04, L.compactStart - bAt) || 0.04;
        const preA = Math.max(0, aAt - 1.0), preB = Math.max(0, bAt - 1.0);
        const d = Math.min(XF, need * 0.8);
        run(['-ss', preA.toFixed(3), '-i', prevSrc, '-ss', preB.toFixed(3), '-i', src,
          '-filter_complex',
          `[0:v]trim=start=${(aAt - preA).toFixed(3)}:duration=${aDur.toFixed(3)},` +
          `setpts=${(need / aDur).toFixed(4)}*(PTS-STARTPTS),${dlOf(prevLine)}${gainFilterFor(prevLine)}${scaleNF},fps=24[a];` +
          `[1:v]trim=start=${(bAt - preB).toFixed(3)}:duration=${bDur.toFixed(3)},` +
          `setpts=${(need / bDur).toFixed(4)}*(PTS-STARTPTS),${dlOf(L)}${gainFilterFor(L)}${scaleNF},fps=24[b];` +
          `[a][b]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${(need - d).toFixed(3)},fps=24[v]`,
          '-map', '[v]', '-t', need.toFixed(3), ...enc, '-an', p]);
      } else {
        run([...seekArgs(src, L.compactStart - back, back),
          '-vf', `${dlOf(L)}${gainFilterFor(L)}${scaleNF},setpts=${(need / back).toFixed(4)}*PTS,fps=24`, '-t', need.toFixed(3), ...enc, '-an', p]);
      }
      parts.push(p);
    }
    const p = join(TMP, `c${String(idx++).padStart(2, '0')}_${L.n}.mp4`);
    run([...seekArgs(src, L.compactStart, L.dur),
      '-vf', `${dlOf(L)}${gainFilterFor(L)}${scale}`, ...enc, '-an', p]);
    parts.push(p);
    cursor = L.end;
    prevLine = L;
    console.log(`  ${L.n} ${L.spk}${L.bg ? '/' + L.bg : ''}  ${L.start.toFixed(2)}~${L.end.toFixed(2)}s  (압축 ${L.compactStart}s)`);
  }
  if (tl.total > cursor + 0.04) {
    const last = tl.lines[tl.lines.length - 1];
    const need = tl.total - cursor;
    const p = join(TMP, `c${String(idx++).padStart(2, '0')}_tail.mp4`);
    run([...seekArgs(clipFor(last), last.compactStart + last.dur - PAD, PAD), '-vf', `${dlOf(last)}${gainFilterFor(last)}${scale},setpts=${(need / PAD).toFixed(4)}*PTS`,
      '-t', need.toFixed(3), ...enc, '-an', p]);
    parts.push(p);
  }

  const list = join(TMP, 'clist.txt');
  writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  const joined = join(TMP, 'cjoined.mp4');
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  run(['-i', joined, '-i', join(BUILD, 'master.wav'),
    '-filter_complex', `[0:v]ass='${assPath.replace(/([:\\])/g, '\\$1')}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile]);

} else if (MODE === 'dialogue_green') {
  // ── 오버더숄더 + 그린스크린 ─────────────────────────────────────
  // 배경 → 키잉된 화자(중경) → 청자 뒷모습(전경) 순으로 쌓는다.
  // 완성 프레임을 넣는 방식(§9.1-4)과 달리 배경이 100% 보존된다.
  const { Resvg } = await import('@resvg/resvg-js');
  const PLACE = JSON.parse(readFileSync(join(ROOT, 'input', 'placement.json'), 'utf8'));
  const greens = Object.fromEntries(argAll('green').map(s => {
    const i = s.indexOf('='); return [s.slice(0, i), resolve(s.slice(i + 1))];
  }));
  // 워터마크 크롭. Flyworks 는 클립마다 워터마크 위치가 달라서 좌/우/상/하를 따로 준다.
  // 캐릭터는 레이어 중앙에 있으므로 가장자리를 20% 정도 잘라도 형태가 살아남는다.
  const cropTop = +(arg('croptop') || 0.22);
  const cropBottom = +(arg('cropbottom') || 0);
  const cropLeft = +(arg('cropleft') || 0);
  const cropRight = +(arg('cropright') || 0);
  const keepW = 1 - cropLeft - cropRight, keepH = 1 - cropTop - cropBottom;
  // 크롭 후 레이어 안에서 캐릭터 중심이 어디로 오는지 (좌우 비대칭 크롭 보정)
  const charCX = (0.5 - cropLeft) / keepW;

  // 그린 스틸을 만들 때 쓴 비율 (인라인 생성기와 일치해야 한다)
  const G_H = 0.66, G_BOTTOM = 0.86;

  // 전경(청자 뒷모습) 전체 프레임 PNG — 캐릭터별 1장
  const fgPng = {};
  for (const id of Object.keys(PLACE)) {
    const g = PLACE[id][TAG];
    const img = new Resvg(readFileSync(join(ROOT, 'input', 'characters', id, 'back.svg'), 'utf8'),
      { fitTo: { mode: 'height', value: Math.round(g.backH * OH) } }).render();
    const src = Buffer.from(img.pixels);
    const canvas = Buffer.alloc(OW * OH * 4);
    const dx = Math.round(OW * (0.5 + g.side * g.backX) - img.width / 2);
    const dy = Math.round(OH * g.backBottom - img.height);
    for (let y = 0; y < img.height; y++) {
      const ty = dy + y; if (ty < 0 || ty >= OH) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = dx + x; if (tx < 0 || tx >= OW) continue;
        const so = (y * img.width + x) * 4, to = (ty * OW + tx) * 4;
        canvas[to] = src[so] * g.backDim; canvas[to + 1] = src[so + 1] * g.backDim;
        canvas[to + 2] = src[so + 2] * g.backDim; canvas[to + 3] = src[so + 3];
      }
    }
    // raw RGBA → PNG (ffmpeg 경유)
    const raw = join(TMP, `fg_${id}.rgba`), png = join(TMP, `fg_${id}.png`);
    writeFileSync(raw, canvas);
    run(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${OW}x${OH}`, '-i', raw, png]);
    fgPng[id] = png;
  }

  const parts = [];
  segs.forEach((s, i) => {
    const speaker = s.key;
    const listener = Object.keys(PLACE).find(k => k !== speaker);
    const g = PLACE[speaker][TAG];
    if (!greens[speaker]) throw new Error(`--green ${speaker}=<파일> 이 필요합니다`);

    // 키잉 레이어 스케일: 캐릭터 높이가 frontH*OH 가 되도록
    const layerH = Math.round((g.frontH * OH) / G_H / keepH);
    const layerW = Math.round(layerH * (736 / 1232) * (keepW / keepH));
    const cx = OW * (0.5 + g.side * g.frontX);
    const ox = Math.round(cx - layerW * charCX);
    // 크롭 후 레이어 안에서 캐릭터 발끝 위치
    const charBottomInLayer = layerH * ((G_BOTTOM - cropTop) / keepH);
    const oy = Math.round(OH * g.frontBottom - charBottomInLayer);

    const bgPng = join(ROOT, 'input', 'backgrounds',
      `${g.side > 0 ? 'dialogue_A' : 'dialogue_B'}.${TAG}.png`);
    const p = join(TMP, `dg${String(i).padStart(2, '0')}.mp4`);
    run(['-ss', String(s.start.toFixed(3)), '-t', String((s.end - s.start).toFixed(3)), '-i', greens[speaker],
      '-loop', '1', '-i', bgPng, '-loop', '1', '-i', fgPng[listener],
      '-filter_complex',
      `[0:v]crop=iw*${keepW.toFixed(4)}:ih*${keepH.toFixed(4)}:iw*${cropLeft.toFixed(4)}:ih*${cropTop.toFixed(4)},` +
      `scale=${layerW}:${layerH},format=rgba,colorkey=${GREEN}:0.28:0.05[k];` +
      `[1:v]scale=${OW}:${OH}[b];[b][k]overlay=${ox}:${oy}[o];[o][2:v]overlay=0:0,fps=24,format=yuv420p[v]`,
      '-map', '[v]', '-an', '-t', String((s.end - s.start).toFixed(3)),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', p]);
    parts.push(p);
    console.log(`  ${speaker} 화자 / ${listener} 전경  ${s.start.toFixed(2)}~${s.end.toFixed(2)}s`);
  });

  const list = join(TMP, 'dglist.txt');
  writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  const joined = join(TMP, 'dgjoined.mp4');
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  run(['-i', joined, '-i', join(BUILD, 'master.wav'),
    '-filter_complex', `[0:v]ass='${assPath.replace(/([:\\])/g, '\\$1')}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile]);

} else if (MODE === 'dialogue') {
  // ── 화자별 완성 프레임 영상을 구간대로 잘라 이어붙인다 ───────────
  const clips = Object.fromEntries(argAll('clip').map(s => {
    const i = s.indexOf('='); return [s.slice(0, i), resolve(s.slice(i + 1))];
  }));
  for (const s of segs) if (!clips[s.key]) throw new Error(`--clip ${s.key}=<파일> 이 필요합니다`);

  const parts = [];
  segs.forEach((s, i) => {
    const p = join(TMP, `seg${String(i).padStart(2, '0')}.mp4`);
    run(['-ss', String(s.start.toFixed(3)), '-t', String((s.end - s.start).toFixed(3)),
      '-i', clips[s.key], '-an',
      '-vf', `scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},fps=24`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', p]);
    parts.push(p);
    console.log(`  ${s.key}  ${s.start.toFixed(2)}~${s.end.toFixed(2)}s`);
  });
  const list = join(TMP, 'list.txt');
  writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
  const joined = join(TMP, 'joined.mp4');
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

  // 오디오는 master.wav 로 교체 (각 클립엔 자기 화자 트랙만 들어 있다)
  run(['-i', joined, '-i', join(BUILD, 'master.wav'),
    '-filter_complex', `[0:v]ass='${assPath.replace(/([:\\])/g, '\\$1')}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile]);

} else {
  // ── 그린스크린 키잉 + 배경 전환 ─────────────────────────────────
  const green = resolve(arg('green'));
  const cropTop = +(arg('croptop') || 0);          // 워터마크 제거용 상단 크롭 비율(0~1)

  // 1) 배경 시퀀스 영상
  const bgList = join(TMP, 'bg.txt');
  writeFileSync(bgList, segs.map(s =>
    `file '${join(ROOT, 'input', 'backgrounds', `${s.key}.${TAG}.png`)}'\nduration ${(s.end - s.start).toFixed(3)}`
  ).join('\n') + `\nfile '${join(ROOT, 'input', 'backgrounds', `${segs[segs.length - 1].key}.${TAG}.png`)}'\n`);
  const bgVid = join(TMP, 'bg.mp4');
  run(['-f', 'concat', '-safe', '0', '-i', bgList,
    '-vf', `scale=${OW}:${OH},fps=24`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-t', String(tl.total), '-pix_fmt', 'yuv420p', bgVid]);
  segs.forEach(s => console.log(`  ${s.key}  ${s.start.toFixed(2)}~${s.end.toFixed(2)}s`));

  // 2) 키잉 + 오버레이
  //
  // chromakey(YUV) + despill 은 캐릭터까지 반투명하게 만든다. colorkey(RGB) 를 쓴다.
  // 상단 크롭으로 "AI生成" 워터마크를 제거하고, 하단 워터마크는 캐릭터 발과 겹쳐
  // 크롭이 불가능하므로 **바닥 그림자**로 덮는다 (디자인 요소로도 자연스럽다).
  // ⚠️ Flyworks 는 결과를 **피사체 중심으로 재프레이밍**한다. 입력 스틸에서 캐릭터를
  // 오른쪽에 두어도 출력은 가운데로 온다. 따라서 구도는 입력이 아니라 이 단계에서 잡는다.
  const layerW = Math.round(OW * +(arg('scale') || 1));
  const posX = arg('posx') !== undefined ? Math.round(OW * +arg('posx')) : Math.round((OW - layerW) / 2);
  const posY = arg('posy') !== undefined ? `H-h-${Math.round(OH * +arg('posy'))}` : 'H-h';
  const vf = cropTop > 0
    ? `crop=iw:ih*${(1 - cropTop).toFixed(4)}:0:ih*${cropTop.toFixed(4)},scale=${layerW}:-1`
    : `scale=${layerW}:-1`;

  const shadow = join(TMP, 'shadow.png');
  {
    const { Resvg } = await import('@resvg/resvg-js');
    const sw = Math.round(OW * 0.52), sh = Math.round(OW * 0.13);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}" viewBox="0 0 ${sw} ${sh}">
      <defs><radialGradient id="g"><stop offset="0%" stop-color="#000" stop-opacity="0.55"/>
      <stop offset="65%" stop-color="#000" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="${sw / 2}" cy="${sh / 2}" rx="${sw / 2}" ry="${sh / 2}" fill="url(#g)"/></svg>`;
    writeFileSync(shadow, new Resvg(svg, { fitTo: { mode: 'width', value: sw } }).render().asPng());
  }

  run(['-i', bgVid, '-i', green, '-i', shadow, '-i', join(BUILD, 'master.wav'),
    '-filter_complex',
    `[1:v]${vf},format=rgba,colorkey=${GREEN}:0.28:0.05[k];` +
    `[0:v][k]overlay=${posX}:${posY}:shortest=1[ov];` +
    `[ov][2:v]overlay=${posX}+(${layerW}-overlay_w)/2:${posY}-${Math.round(OH * 0.006)}[sh];` +
    `[sh]ass='${assPath.replace(/([:\\])/g, '\\$1')}':fontsdir=/System/Library/Fonts,format=yuv420p[v]`,
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k', '-t', String(tl.total), '-movflags', '+faststart', outFile]);
}

console.log(`\n✅ ${outFile}`);
