#!/usr/bin/env node
/**
 * 21-docx-to-script — 대본 **.docx 의 표** → `input/script.tsv`
 *
 * 대본 docx 는 아래 5열 표여야 한다(첫 행은 머리글):
 *     # | 화자 | 대사 | 컷 | 화면
 *   #    순번
 *   화자  cast.json 의 speakers[].name 과 **정확히 일치**해야 한다
 *   대사  그대로 TTS 에 들어간다
 *   컷    표정 이름. cast.json 의 front 키와 일치해야 한다 (없으면 기본으로 접힘)
 *   화면  상단 숫자/키워드 카드. 비워도 된다
 *
 * gap(줄 사이 공백)은 docx 에 없으므로 기본값을 채운다. 총 길이가 목표를 벗어나면
 * 01-build-audio 가 exit 2 로 보정 지시를 준다 → gap 만 조정해 재실행한다(§6).
 *
 * ⚠️ macOS 는 한글을 NFD 로 주고받는 구간이 있다. 화자·표정 이름 비교 전에 NFC 로 맞춘다.
 *
 * 사용: node bin/21-docx-to-script.mjs <대본.docx> [--cast input/cast.json] [--gap 0.45]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const DOCX = a.find((v, i) => !v.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
const CAST = arg('cast') || 'input/cast.json';
const OUT = arg('out') || 'input/script.tsv';
const GAP = +(arg('gap') || 0.45);
if (!DOCX || !existsSync(DOCX)) { console.error('사용: node bin/21-docx-to-script.mjs <대본.docx>'); process.exit(1); }

const nfc = s => s.normalize('NFC');
const cast = JSON.parse(readFileSync(CAST, 'utf8'));
const byName = new Map();
for (const [sid, s] of Object.entries(cast.speakers)) byName.set(nfc(s.name), { sid, exprs: Object.keys(s.front).map(nfc), neutral: nfc(s.neutral || '기본') });

// docx 는 zip. 의존성 없이 unzip 으로 document.xml 만 꺼낸다.
const xml = execFileSync('unzip', ['-p', DOCX, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64 << 20 });
const text = (frag) => nfc(
  [...frag.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
).trim();

const rows = [...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(m =>
  [...m[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map(c => text(c[0])));
if (!rows.length) { console.error('표를 찾지 못했습니다. 대본이 5열 표 형식인지 확인하세요.'); process.exit(1); }

const head = rows[0];
const body = rows.slice(1).filter(r => r.length >= 3 && /^\d+$/.test(r[0]));
if (!body.length) { console.error(`표는 찾았지만 대사 행이 없습니다. 머리글: ${head.join(' | ')}`); process.exit(1); }

const out = [], warn = [];
for (const r of body) {
  const [n, who, line, cut = '', card = ''] = r;
  const sp = byName.get(nfc(who));
  if (!sp) { warn.push(`행 ${n}: 화자 "${who}" 가 cast.json 에 없습니다`); continue; }
  let expr = nfc(cut) || sp.neutral;
  if (!sp.exprs.includes(expr)) { warn.push(`행 ${n}: 표정 "${cut}" 없음 → "${sp.neutral}" 으로 대체`); expr = sp.neutral; }
  out.push([String(n).padStart(2, '0'), sp.sid, GAP.toFixed(2), line, expr, card].join('\t'));
}
writeFileSync(OUT, out.join('\n') + '\n');

console.log(`✓ ${OUT}  ${out.length}줄  (gap 기본 ${GAP}s)`);
const cnt = {};
for (const l of out) { const s = l.split('\t')[1]; cnt[s] = (cnt[s] || 0) + 1; }
console.log(`  화자별: ${Object.entries(cnt).map(([k, v]) => `${k} ${v}줄`).join(' / ')}`);
const cards = out.filter(l => l.split('\t')[5]).length;
console.log(`  화면 카드 ${cards}개`);
if (warn.length) { console.log('\n⚠️'); warn.forEach(w => console.log('   ' + w)); }
console.log('\n다음: node bin/01-build-audio.mjs  (exit 2 면 gap 조정 후 재실행)');
