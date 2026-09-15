#!/usr/bin/env node
/**
 * 07-strip-watermark — Flyworks 워터마크를 **프레임 단위로** 검출·복원해 완전 제거
 *
 * ⚠️ 이 워터마크는 고정 위치가 아니다. 주기적으로 **나타났다 사라지며 매번 다른
 *    위치에** 뜬다(실측: 2~3초 우측 중앙, 16~17초 좌측 상단, 그 외 없음).
 *    한 프레임에서 잡은 좌표로 `delogo` 를 고정으로 걸면 나머지 구간에서 그대로 떠다닌다.
 *
 * ⚠️ ffmpeg 두 개를 stdin/stdout 으로 직접 잇지 말 것.
 *    백프레셔를 어떻게 다뤄도 **뒷부분 프레임이 통째로 사라졌다**(실측: 984→910, 정확히 74프레임).
 *    디코드 → raw 파일 → 처리 → raw 파일 → 인코드 로 단계를 분리해야 확실하다.
 *    (39초 클립 기준 임시 raw 약 2.7GB, 처리 후 삭제)
 *
 * 복원은 **시간축**으로 한다. 공간 보간은 털·질감 위에 가로 얼룩을 남긴다.
 * 워터마크가 버스트로만 나타나므로 직전 깨끗한 프레임의 같은 영역을 복사하면
 * 질감이 완전히 보존된다. 캐릭터 머리는 거의 정지 상태라 어긋나지 않는다.
 *
 * 사용: node bin/07-strip-watermark.mjs <입력.mp4> <출력.mp4>
 */
import { execFileSync } from 'node:child_process';
import { openSync, readSync, writeSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = (() => {
  try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  return join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
})();
const FFPROBE = join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe');

const [inp, outp] = process.argv.slice(2);
if (!inp || !outp) { console.error('사용: 07-strip-watermark.mjs <입력.mp4> <출력.mp4>'); process.exit(1); }

const meta = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0:s=,', inp], { encoding: 'utf8' }).trim().split(',');
const W = +meta[0], H = +meta[1];
const [fn, fd] = meta[2].split('/').map(Number);
const FPS = (fn / (fd || 1)).toFixed(6);
const FRAME = W * H * 3;

const tag = `${process.pid}_${W}x${H}`;
const rawIn = join(tmpdir(), `wm_in_${tag}.raw`);
const rawOut = join(tmpdir(), `wm_out_${tag}.raw`);

const CELL = 24, R = CELL * 3;
let frames = 0, hits = 0;
let lastClean = null;

function inpaint(buf, x0, y0, x1, y1) {
  const lx = Math.max(0, x0 - 1), rx = Math.min(W - 1, x1 + 1);
  const ty = Math.max(0, y0 - 1), by = Math.min(H - 1, y1 + 1);
  for (let y = y0; y <= y1; y++) {
    const lo = (y * W + lx) * 3, ro = (y * W + rx) * 3;
    for (let x = x0; x <= x1; x++) {
      const th = (x - lx) / Math.max(1, rx - lx);
      const to = (ty * W + x) * 3, bo = (by * W + x) * 3;
      const tv = (y - ty) / Math.max(1, by - ty);
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        buf[o + c] = (buf[lo + c] * (1 - th) + buf[ro + c] * th
          + buf[to + c] * (1 - tv) + buf[bo + c] * tv) / 2;
      }
    }
  }
}

function stripFrame(buf) {
  const hit = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3, r = buf[o], g = buf[o + 1], b = buf[o + 2];
      if (b > 110 && b - g > 35 && b - r > 15) hit.push(x, y);
    }
  }
  if (hit.length < 120) return false;

  // 배경에 보라 계열이 흩어져 있으면 전체 bbox 가 프레임 전체가 된다.
  // 격자 밀도로 최빈 덩어리만 로고로 인정한다.
  const grid = new Map();
  for (let i = 0; i < hit.length; i += 2) {
    const k = ((hit[i] / CELL) | 0) * 10000 + ((hit[i + 1] / CELL) | 0);
    grid.set(k, (grid.get(k) || 0) + 1);
  }
  const [bk] = [...grid.entries()].sort((a, b) => b[1] - a[1])[0];
  const cx = ((bk / 10000) | 0) * CELL + CELL / 2, cy = (bk % 10000) * CELL + CELL / 2;

  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < hit.length; i += 2) {
    const x = hit[i], y = hit[i + 1];
    if (Math.abs(x - cx) > R || Math.abs(y - cy) > R) continue;
    n++;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (n < 60) return false;

  const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
  x0 = Math.max(0, x0 - Math.round(lw * 1.15));
  x1 = Math.min(W - 1, x1 + Math.round(lw * 1.15));
  y0 = Math.max(0, y0 - Math.round(lh * 0.30));
  y1 = Math.min(H - 1, y1 + Math.round(lh * 1.90));

  if (lastClean) {
    for (let y = y0; y <= y1; y++) {
      const off = (y * W + x0) * 3, len = (x1 - x0 + 1) * 3;
      lastClean.copy(buf, off, off, off + len);
    }
  } else {
    inpaint(buf, x0, y0, x1, y1);
  }
  return true;
}

// 1) 디코드 → raw 파일
execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', inp, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawIn]);
const total = Math.floor(statSync(rawIn).size / FRAME);

// 2) 프레임 단위 처리
const fdIn = openSync(rawIn, 'r'), fdOut = openSync(rawOut, 'w');
const buf = Buffer.allocUnsafe(FRAME);
for (let i = 0; i < total; i++) {
  let got = 0;
  while (got < FRAME) {
    const r = readSync(fdIn, buf, got, FRAME - got, null);
    if (r <= 0) break;
    got += r;
  }
  if (got < FRAME) break;
  frames++;
  if (stripFrame(buf)) hits++;
  else { if (!lastClean) lastClean = Buffer.allocUnsafe(FRAME); buf.copy(lastClean); }
  let put = 0;
  while (put < FRAME) put += writeSync(fdOut, buf, put, FRAME - put, null);
}
closeSync(fdIn); closeSync(fdOut);

// 3) 인코드. 오디오는 합성 단계에서 master 로 교체하므로 넣지 않는다.
execFileSync(FFMPEG, ['-y', '-v', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-framerate', FPS, '-i', rawOut,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-an', outp]);

try { unlinkSync(rawIn); unlinkSync(rawOut); } catch {}
console.log(`  ${inp.split('/').pop()} → ${outp.split('/').pop()}  ${frames}/${total}프레임, ${hits}프레임에서 제거`);
