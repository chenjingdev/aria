// VSCO 2 CE(CC0) → vsco.sf2 — 필하모니아에 없는 색채 악기 보강
// 하프·글로켄슈필·마림바·실로폰·첼로 섹션 피치카토·팀파니. 전부 원샷(자연 감쇠, 루프 없음).
// 파일명 규칙이 악기마다 달라 악기별 정규식으로 파싱한다. 팀파니는 파일명에 음정이 없어
// 자기상관 f0 검출로 각 북의 음을 알아내 매핑한다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeSf2 } from "./sf2write.mjs";
import { convertAll, readWavMono, processSample } from "./phil-lib.mjs";

const SC = "/private/tmp/claude-501/-Users-chenjing-dev-tmp-2026-08-03-new-chat-1/5473a906-75d2-4203-845d-3d8e8cf8d248/scratchpad";
const SRC = path.join(SC, "vsco/VSCO-2-CE-master");
const TMP = path.join(SC, "phil/wav-vsco");
const OUT = path.join(os.homedir(), ".aria/soundfonts/vsco.sf2");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const parseNote = n => {
  const m = /^([A-G])([s#b]?)(\d)$/.exec(n);
  if (!m) return null;
  return { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === "b" ? -1 : m[2] ? 1 : 0) + (+m[3] + 1) * 12;
};

// rx 캡처: [1]=음이름, [2]=레이어 순서 문자열(없으면 단일 레이어)
const INSTRUMENTS = [
  { name: "Harp", short: "hp", program: 46, dir: "Strings/Harp", rx: /^KSHarp_([A-G][s#b]?\d)_(mf|f)\.wav$/, layerOrder: ["mf", "f"] },
  { name: "Glockenspiel", short: "gk", program: 9, dir: "Percussion/Glock", rx: /^glock_medium_([A-G][s#b]?\d)\.wav$/ },
  { name: "Marimba", short: "mb", program: 12, dir: "Percussion/Marimba", rx: /^Marimba_hit_Outrigger_([A-G][s#b]?\d)_loud_01\.wav$/ },
  { name: "Xylophone", short: "xy", program: 13, dir: "Percussion/Xylo", rx: /^Xylo_Medium_([A-G][s#b]?\d)_ff_01_far\.wav$/ },
  { name: "Cello Pizz", short: "vcp", program: 45, dir: "Strings/Cello Section/pizzT", rx: /^pizzT_([A-G][s#b]?\d)_v(\d)_RR1\.wav$/, layerOrder: ["1", "2"] },
  { name: "Timpani", short: "tp", program: 47, dir: "Percussion/Timpani", timpani: true }
];

// 자기상관 f0 검출 (40~250Hz 대역, 어택 후 0.5초 창)
function detectF0(pcm, sr) {
  const a = Math.floor(0.05 * sr), n = Math.min(pcm.length - a, Math.floor(0.5 * sr));
  if (n < sr / 40 * 2) return null;
  const x = Float64Array.from(pcm.subarray(a, a + n));
  let best = 0, bestLag = 0;
  const minLag = Math.floor(sr / 250), maxLag = Math.floor(sr / 40);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 2) s += x[i] * x[i + lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  return bestLag ? sr / bestLag : null;
}
const hzToMidi = hz => Math.round(69 + 12 * Math.log2(hz / 440));
const MIDI_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const midiName = m => MIDI_NAMES[m % 12] + (Math.floor(m / 12) - 1);

const t0 = Date.now();
const samples = [], instruments = [], presets = [];
for (const inst of INSTRUMENTS) {
  const dirPath = path.join(SRC, inst.dir);
  const jobs = [];
  const entries = []; // {midi 또는 drumNo, layerIdx, wav}
  if (inst.timpani) {
    // Timpani{N}_Hit_v{V}_rr1_Sum.wav — 북 번호별로 모으고 음정은 나중에 검출
    const rx = /^Timpani(\d)_Hit_v(\d)_rr1_Sum\.wav$/;
    for (const f of fs.readdirSync(dirPath)) {
      const m = rx.exec(f);
      if (!m) continue;
      const dst = path.join(TMP, `tp-${m[1]}-v${m[2]}.wav`);
      jobs.push({ src: path.join(dirPath, f), dst });
      entries.push({ drum: +m[1], layer: +m[2], wav: dst });
    }
  } else {
    for (const f of fs.readdirSync(dirPath)) {
      const m = inst.rx.exec(f);
      if (!m) continue;
      const midi = parseNote(m[1]);
      if (midi === null) continue;
      const layerKey = m[2] ?? "";
      const layer = inst.layerOrder ? inst.layerOrder.indexOf(layerKey) : 0;
      if (layer < 0) continue;
      const dst = path.join(TMP, `${inst.short}-${midi}-${layer}.wav`);
      jobs.push({ src: path.join(dirPath, f), dst });
      entries.push({ midi, layer, wav: dst });
    }
  }
  const { failed } = await convertAll(jobs);

  // 팀파니: 북마다 가장 센 레이어에서 f0 검출 → midi 부여
  if (inst.timpani) {
    const byDrum = new Map();
    for (const e of entries) {
      if (!fs.existsSync(e.wav)) continue;
      if (!byDrum.has(e.drum)) byDrum.set(e.drum, []);
      byDrum.get(e.drum).push(e);
    }
    entries.length = 0;
    for (const [drum, es] of byDrum) {
      const loudest = es.reduce((a, b) => (b.layer > a.layer ? b : a));
      const { pcm, rate } = readWavMono(loudest.wav);
      const hz = detectF0(pcm, rate);
      if (!hz) { console.log(`  ⚠ 팀파니 ${drum}번: f0 검출 실패 — 제외`); continue; }
      const midi = hzToMidi(hz);
      console.log(`  팀파니 ${drum}번 → ${midiName(midi)} (${hz.toFixed(1)}Hz)`);
      const layers = [...new Set(es.map(e => e.layer))].sort((a, b) => a - b);
      for (const e of es) entries.push({ midi, layer: layers.indexOf(e.layer), wav: e.wav });
    }
  }

  // midi → 레이어 정렬 → 가공
  const processed = new Map();
  for (const e of entries.sort((a, b) => a.midi - b.midi || a.layer - b.layer)) {
    if (!fs.existsSync(e.wav)) continue;
    const { pcm, rate } = readWavMono(e.wav);
    const p = processSample(pcm, rate, true);
    if (p.soundingSec < 0.03) continue;
    if (!processed.has(e.midi)) processed.set(e.midi, []);
    processed.get(e.midi).push({ p, rate, layer: e.layer });
  }
  const midis = [...processed.keys()].sort((a, b) => a - b);
  if (!midis.length) { console.log(`⚠ ${inst.name}: 샘플 없음 — 건너뜀`); continue; }
  const zones = [];
  for (const [i, midi] of midis.entries()) {
    const keyLo = i === 0 ? Math.max(0, midi - 12) : Math.floor((midis[i - 1] + midi) / 2) + 1;
    const keyHi = i === midis.length - 1 ? Math.min(127, midi + 12) : Math.floor((midi + midis[i + 1]) / 2);
    const layers = processed.get(midi);
    for (const [k, { p, rate }] of layers.entries()) {
      samples.push({
        name: `${inst.short}-${midi}-${k}`, pcm: p.pcm, sampleRate: rate,
        origPitch: midi, loopStart: 0, loopEnd: p.pcm.length - 1, loop: false
      });
      zones.push({
        keyLo, keyHi,
        velLo: k === 0 ? 0 : Math.round(127 * k / layers.length) + 1,
        velHi: k === layers.length - 1 ? 127 : Math.round(127 * (k + 1) / layers.length),
        sampleIdx: samples.length - 1, loop: false
      });
    }
  }
  console.log(`${inst.name}: 음 ${midis.length}개, 존 ${zones.length}개${failed ? ` (변환 실패 ${failed})` : ""} [${midiName(midis[0])}~${midiName(midis.at(-1))}]`);
  instruments.push({
    name: inst.name,
    globalGens: [[34, -9000], [38, 3102]], // 원샷 — 릴리스 ~6s로 자연 감쇠를 자르지 않는다
    zones
  });
  presets.push({ name: inst.name, bank: 0, program: inst.program, instIdx: instruments.length - 1 });
  inst.midis = midis;
}

const res = writeSf2({
  outPath: OUT,
  infoName: "VSCO 2 CE Selection",
  copyright: "VSCO 2 Community Edition source samples — CC0 1.0; see the source LICENSE",
  samples, instruments, presets
});
console.log(`\nvsco.sf2: ${(res.bytes / 1024 / 1024).toFixed(1)}MB · 샘플 ${res.samples}개 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 스윕: 전 녹음 음 × vel 3단 발음 확인 ──
const { parseSf2, renderSf2Voice } = await import("../src/sf2.js");
const sf = parseSf2(OUT);
console.log(`파서: 프리셋 ${sf.presets.size}개, 샘플 ${sf.shdr.length}개`);
let checked = 0, silent = 0, nan = 0;
for (const inst of INSTRUMENTS) {
  for (const midi of inst.midis ?? []) {
    for (const vel of [0.3, 0.7, 1.0]) {
      const buf = renderSf2Voice(sf, 0, inst.program, midi, vel, 0.4, 44100);
      checked++;
      let s = 0;
      for (let i = 0; i < Math.min(buf.length, 22050); i++) { if (!Number.isFinite(buf[i])) nan++; s += buf[i] * buf[i]; }
      if (Math.sqrt(s / 22050) < 1e-4) { silent++; console.log(`  ⚠ 무음 ${inst.short}-${midi} vel${vel}`); }
    }
  }
}
console.log(`스윕 ${checked}건: 무음 ${silent}${nan ? ` · ⚠ NaN ${nan}` : ""}`);
