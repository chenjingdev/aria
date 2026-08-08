// Salamander Drumkit(로컬 원본 README 기준 CC BY-SA 3.0) → salamander-kit.sf2 (bank 128 program 0)
// 어쿠스틱 밴드 드럼 실녹음, 벨로시티 최대 6층(PP~FF). 표준 DRUM_PIECES 키에 매핑.
// 원본에 없는 피스는 근사 대체: clap ← 스네어즈-오프 스네어, shaker ← 풋 하이햇 칙.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeSf2 } from "./sf2write.mjs";
import { convertAll, readWavMono, processSample } from "./phil-lib.mjs";

const SC = "/private/tmp/claude-501/-Users-chenjing-dev-tmp-2026-08-03-new-chat-1/5473a906-75d2-4203-845d-3d8e8cf8d248/scratchpad";
const SRC = path.join(SC, "salamander-kit/OH");
const TMP = path.join(SC, "phil/wav-sala");
const OUT = path.join(os.homedir(), ".aria/soundfonts/salamander-kit.sf2");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const DYN = ["PP", "P", "MP", "MF", "F", "FF"];
// srcPiece: 파일명 접두. shift: 반음 이동(샘플 복제 트릭 — tom-m은 hiTom을 4반음 내려 만든다)
const PIECES = [
  { key: 36, name: "kick", srcPiece: "kick" },
  { key: 38, name: "snare", srcPiece: "snare" },
  { key: 37, name: "rim", srcPiece: "snareStick" },
  { key: 39, name: "clap", srcPiece: "snareOFF" },
  { key: 42, name: "hhc", srcPiece: "hihatClosed" },
  { key: 46, name: "hho", srcPiece: "hihatOpen" },
  { key: 43, name: "tom-l", srcPiece: "loTom" },
  { key: 47, name: "tom-m", srcPiece: "hiTom", shift: -4 },
  { key: 50, name: "tom-h", srcPiece: "hiTom" },
  { key: 49, name: "crash", srcPiece: "crash1" },
  { key: 51, name: "ride", srcPiece: "ride1" },
  { key: 70, name: "shaker", srcPiece: "hihatFoot" }
];

const t0 = Date.now();
const samples = [], zones = [];
for (const pc of PIECES) {
  // dyn → 첫 라운드로빈 파일
  const rx = new RegExp(`^${pc.srcPiece}_OH_(${DYN.join("|")})_(\\d+)\\.wav$`);
  const byDyn = {};
  for (const f of fs.readdirSync(SRC)) {
    const m = rx.exec(f);
    if (!m) continue;
    if (!byDyn[m[1]] || +m[2] < byDyn[m[1]].rr) byDyn[m[1]] = { rr: +m[2], file: path.join(SRC, f) };
  }
  const dyns = DYN.filter(d => byDyn[d]);
  if (!dyns.length) { console.log(`⚠ ${pc.name}(${pc.srcPiece}): 파일 없음`); continue; }
  const jobs = dyns.map(d => ({ src: byDyn[d].file, dst: path.join(TMP, `${pc.name}-${d}.wav`) }));
  await convertAll(jobs);
  const layers = [];
  for (const d of dyns) {
    const wav = path.join(TMP, `${pc.name}-${d}.wav`);
    if (!fs.existsSync(wav)) continue;
    const { pcm, rate } = readWavMono(wav);
    const p = processSample(pcm, rate, true);
    if (p.soundingSec < 0.015) continue;
    layers.push({ dyn: d, p, rate });
  }
  if (!layers.length) { console.log(`⚠ ${pc.name}: 사용 가능 샘플 없음`); continue; }
  for (const [k, { dyn, p, rate }] of layers.entries()) {
    samples.push({
      name: `${pc.name}-${dyn}`, pcm: p.pcm, sampleRate: rate,
      origPitch: pc.key + (pc.shift ? -pc.shift : 0), // shift 반음만큼 낮게 재생되도록 origPitch를 올린다
      loopStart: 0, loopEnd: p.pcm.length - 1, loop: false
    });
    zones.push({
      keyLo: pc.key, keyHi: pc.key,
      velLo: k === 0 ? 0 : Math.round(127 * k / layers.length) + 1,
      velHi: k === layers.length - 1 ? 127 : Math.round(127 * (k + 1) / layers.length),
      sampleIdx: samples.length - 1, loop: false
    });
  }
  console.log(`${pc.name}: 레이어 ${layers.length}개 (${dyns.join(",")})`);
}

const instruments = [{
  name: "Band Kit",
  globalGens: [[34, -9000], [38, 2486]], // release ~4.2s — 크래시·라이드 링을 살린다
  zones
}];
const presets = [{ name: "Salamander Kit", bank: 128, program: 0, instIdx: 0 }];
const res = writeSf2({
  outPath: OUT,
  infoName: "Salamander Drumkit",
  copyright: "Salamander Drumkit © Alexander Holm — local source README: CC BY-SA 3.0",
  samples, instruments, presets
});
console.log(`\nsalamander-kit.sf2: ${(res.bytes / 1024 / 1024).toFixed(1)}MB · 샘플 ${res.samples}개 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 스윕
const { parseSf2, renderSf2Voice } = await import("../src/sf2.js");
const sf = parseSf2(OUT);
let checked = 0, silent = 0, nan = 0;
for (const key of [...new Set(zones.map(z => z.keyLo))]) {
  for (const vel of [0.2, 0.5, 0.8, 1.0]) {
    const buf = renderSf2Voice(sf, 128, 0, key, vel, 0.3, 44100);
    checked++;
    let s = 0;
    for (let i = 0; i < Math.min(buf.length, 22050); i++) { if (!Number.isFinite(buf[i])) nan++; s += buf[i] * buf[i]; }
    if (Math.sqrt(s / 22050) < 1e-4) { silent++; console.log(`  ⚠ 무음 key ${key} vel${vel}`); }
  }
}
console.log(`스윕 ${checked}건: 무음 ${silent}${nan ? ` · ⚠ NaN ${nan}` : ""}`);
