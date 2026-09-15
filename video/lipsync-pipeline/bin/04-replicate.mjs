#!/usr/bin/env node
/**
 * 04-replicate — Replicate API 로 립싱크 렌더 (MCP 없이 직접 호출)
 *
 * Replicate 원격 MCP 는 브라우저 OAuth 가 필요해 비대화 세션에서 쓸 수 없다.
 * MCP 는 이 REST API 를 감싼 것뿐이므로, 토큰이 있으면 결과는 동일하다.
 *
 * 준비:  https://replicate.com/account/api-tokens 에서 토큰 발급
 *        export REPLICATE_API_TOKEN=r8_...
 *
 * 사용:
 *   node bin/04-replicate.mjs --search lipsync          # 모델 탐색
 *   node bin/04-replicate.mjs --model <owner/name> \
 *        --image build/sample_avatar.png \
 *        --audio build/fw_audio_40s.mp3 \
 *        --out output/replicate_test.mp4
 *
 * 주의: 대부분의 립싱크 모델은 video-to-video 다 (입력 영상 필요).
 *       스틸 이미지로 시작하려면 image+audio 를 받는 모델을 골라야 한다
 *       (예: sadtalker 계열). --search 결과의 입력 스키마를 확인할 것.
 */
import { readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const API = 'https://api.replicate.com/v1';
const TOKEN = process.env.REPLICATE_API_TOKEN;

if (!TOKEN) {
  console.error(`❌ REPLICATE_API_TOKEN 이 없습니다.

브라우저 로그인만으로는 API 를 호출할 수 없습니다. 토큰이 필요합니다:

  1. https://replicate.com/account/api-tokens 접속
  2. 토큰 생성 후 복사 (r8_... 형식)
  3. 아래 중 하나:
       export REPLICATE_API_TOKEN=r8_xxxxx        # 이 셸에서만
       echo 'r8_xxxxx' > ~/.replicate-token       # 파일로 (권장, 채팅 로그에 안 남음)
         → 그 경우: export REPLICATE_API_TOKEN=$(cat ~/.replicate-token)

대안: 대화형 Claude Code 세션에서 /mcp 로 replicate 를 인증하면
      MCP 경로로도 쓸 수 있습니다 (이미 등록은 완료됨).`);
  process.exit(1);
}

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

async function api(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...H, ...opts.headers } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${path}\n${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

// ── 모델 탐색 ───────────────────────────────────────────────────────
if (args.includes('--search')) {
  const q = arg('search') || 'lipsync';
  const res = await api(`/models?query=${encodeURIComponent(q)}`);
  console.log(`"${q}" 검색 결과 ${res.results?.length || 0}건\n`);
  for (const m of (res.results || []).slice(0, 20)) {
    const inputs = m.latest_version?.openapi_schema?.components?.schemas?.Input?.properties || {};
    const keys = Object.keys(inputs);
    const kind = keys.some(k => /^image|source_image|face/.test(k)) ? 'image+audio 가능'
      : keys.some(k => /video/.test(k)) ? 'video-to-video'
      : '스키마 미확인';
    console.log(`  ${m.owner}/${m.name}`);
    console.log(`    ${(m.description || '').slice(0, 90)}`);
    console.log(`    입력: ${keys.slice(0, 8).join(', ')}`);
    console.log(`    → ${kind}  실행 ${m.run_count?.toLocaleString() || '?'}회\n`);
  }
  process.exit(0);
}

// ── 파일 업로드 ─────────────────────────────────────────────────────
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4' };

async function upload(path) {
  const buf = readFileSync(path);
  const fd = new FormData();
  fd.append('content', new Blob([buf], { type: MIME[extname(path).toLowerCase()] || 'application/octet-stream' }), basename(path));
  const r = await fetch(`${API}/files`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
  if (!r.ok) throw new Error(`업로드 실패 ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const j = await r.json();
  const url = j.urls?.get || j.url;
  console.log(`  ↑ ${basename(path)} (${(statSync(path).size / 1024 / 1024).toFixed(2)}MB) → ${url}`);
  return url;
}

// ── 예측 실행 + 폴링 ────────────────────────────────────────────────
const model = arg('model');
if (!model) { console.error('--model <owner/name> 필요. 먼저 --search lipsync 로 탐색하세요.'); process.exit(1); }
const imgPath = arg('image'), audPath = arg('audio'), vidPath = arg('video');
const outPath = arg('out') || 'output/replicate_test.mp4';

console.log(`모델: ${model}`);
const [owner, name] = model.split('/');
const meta = await api(`/models/${owner}/${name}`);
const version = meta.latest_version?.id;
const schema = meta.latest_version?.openapi_schema?.components?.schemas?.Input?.properties || {};
console.log(`버전: ${version}`);
console.log(`입력 스키마: ${Object.keys(schema).join(', ')}\n`);

console.log('업로드');
const input = {};
// 스키마 키 이름이 모델마다 달라 자동 매핑한다
const pick = (cands) => cands.find(k => k in schema);
if (imgPath) {
  const k = pick(['image', 'source_image', 'face', 'input_image', 'portrait']);
  if (!k) throw new Error(`이 모델은 이미지 입력을 받지 않습니다. 스키마: ${Object.keys(schema)}`);
  input[k] = await upload(imgPath);
}
if (vidPath) {
  const k = pick(['video', 'video_input', 'face_video', 'input_video', 'video_url']);
  if (!k) throw new Error(`이 모델은 영상 입력을 받지 않습니다. 스키마: ${Object.keys(schema)}`);
  input[k] = await upload(vidPath);
}
if (audPath) {
  const k = pick(['audio', 'driven_audio', 'audio_input', 'audio_url', 'input_audio']);
  if (!k) throw new Error(`이 모델은 오디오 입력을 받지 않습니다. 스키마: ${Object.keys(schema)}`);
  input[k] = await upload(audPath);
}

// --param key=value 를 여러 번 줄 수 있다. 숫자/불리언은 자동 변환.
// SadTalker 는 기본이 얼굴 크롭이므로 전체 프레임을 쓰려면 preprocess=full 이 필수다.
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--param') continue;
  const [k, ...rest] = args[i + 1].split('=');
  const v = rest.join('=');
  if (!(k in schema)) { console.error(`⚠️  스키마에 없는 파라미터 무시: ${k}`); continue; }
  input[k] = v === 'true' ? true : v === 'false' ? false : (/^-?\d+(\.\d+)?$/.test(v) ? +v : v);
}
console.log('\n예측 생성');
console.log(`  입력: ${JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) =>
  [k, typeof v === 'string' && v.startsWith('http') ? '<uploaded>' : v])))}`);
let pred = await api('/predictions', { method: 'POST', body: JSON.stringify({ version, input }) });
console.log(`  id=${pred.id}`);

const t0 = Date.now();
while (['starting', 'processing'].includes(pred.status)) {
  await new Promise(r => setTimeout(r, 5000));
  pred = await api(`/predictions/${pred.id}`);
  process.stderr.write(`  ${pred.status} ${Math.round((Date.now() - t0) / 1000)}s\r`);
}
console.log(`\n상태: ${pred.status}`);

if (pred.status !== 'succeeded') {
  console.error(`실패: ${pred.error || '(사유 없음)'}`);
  if (pred.logs) console.error(pred.logs.split('\n').slice(-15).join('\n'));
  process.exit(1);
}

const url = Array.isArray(pred.output) ? pred.output[0] : (pred.output?.video || pred.output);
console.log(`출력: ${url}`);
const vid = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync(outPath, vid);
console.log(`✅ ${outPath} (${(vid.length / 1024 / 1024).toFixed(2)}MB)`);
console.log(`   소요 ${Math.round((Date.now() - t0) / 1000)}s / 예측시간 ${pred.metrics?.predict_time?.toFixed(1) || '?'}s`);
