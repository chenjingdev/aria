// 필하모니아 현악 샘플 → philharmonia.sf2 빌드 파이프라인
// 1) arco-normal 샘플 선별(음마다 셈여림별 최장 길이) 2) mp3→PCM 3) 무음 트림·자동 루프(크로스페이드)
// 4) 키/벨로시티 존 구성 5) SF2 인코딩 6) aria 파서로 라운드트립 + 지속음 검증
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeSf2 } from "./sf2write.mjs"; // tools/ 안에서 실행
import { DYN, noteToMidi, convertAll, readWavMono, processSample } from "./phil-lib.mjs";

const SC = "/private/tmp/claude-501/-Users-chenjing-dev-tmp-2026-08-03-new-chat-1/5473a906-75d2-4203-845d-3d8e8cf8d248/scratchpad";
const TMP = path.join(SC, "phil/wav");

// art: 파일명 접미(주법). oneShot: 루프 없이 자연 감쇠(피치카토 등) — 지속 검사도 면제.
// 첼로 pizz는 낱음 녹음이 없어(프레이즈 2개뿐) 제외 — VSCO 등 다른 소스에서 채운다.
// 사용법: node build-phil.mjs [strings|winds|brass]  (가족당 한 번 실행)
const FAMILIES = {
  strings: {
    src: "phil/Strings", out: "philharmonia.sf2", info: "Philharmonia Strings",
    instruments: [
      { dir: "violin", prefix: "violin", name: "Violin", program: 40, short: "vln", art: "arco-normal" },
      { dir: "viola", prefix: "viola", name: "Viola", program: 41, short: "vla", art: "arco-normal" },
      { dir: "cello", prefix: "cello", name: "Cello", program: 42, short: "vc", art: "arco-normal" },
      { dir: "double bass", prefix: "double-bass", name: "Contrabass", program: 43, short: "cb", art: "arco-normal" },
      { dir: "violin", prefix: "violin", name: "Violin Pizz", program: 44, short: "vlnp", art: "pizz-normal", oneShot: true },
      { dir: "viola", prefix: "viola", name: "Viola Pizz", program: 45, short: "vlap", art: "pizz-normal", oneShot: true },
      { dir: "double bass", prefix: "double-bass", name: "Contrabass Pizz", program: 46, short: "cbp", art: "pizz-normal", oneShot: true },
      { dir: "violin", prefix: "violin", name: "Violin Sord", program: 48, short: "vlns", art: "con-sord" }
    ]
  },
  winds: {
    src: "phil/Woodwind/Woodwind", out: "phil-winds.sf2", info: "Philharmonia Winds",
    // 72(피콜로)·74(리코더) 슬롯은 GM에 없는 베이스클라리넷·콘트라바순에 전용(프리셋에서 이름 지정)
    instruments: [
      { dir: "flute", prefix: "flute", name: "Flute", program: 73, short: "fl", art: "normal" },
      { dir: "oboe", prefix: "oboe", name: "Oboe", program: 68, short: "ob", art: "normal" },
      { dir: "cor anglais", prefix: "cor-anglais", name: "English Horn", program: 69, short: "eh", art: "normal" },
      { dir: "clarinet", prefix: "clarinet", name: "Clarinet", program: 71, short: "cl", art: "normal" },
      { dir: "bass clarinet", prefix: "bass-clarinet", name: "Bass Clarinet", program: 72, short: "bcl", art: "normal" },
      { dir: "bassoon", prefix: "bassoon", name: "Bassoon", program: 70, short: "bsn", art: "normal" },
      { dir: "contrabassoon", prefix: "contrabassoon", name: "Contrabassoon", program: 74, short: "cbsn", art: "normal" },
      { dir: "saxophone", prefix: "saxophone", name: "Alto Sax", program: 65, short: "sax", art: "normal" }
    ]
  },
  brass: {
    src: "phil/Brass/Brass", out: "phil-brass.sf2", info: "Philharmonia Brass",
    instruments: [
      { dir: "trumpet", prefix: "trumpet", name: "Trumpet", program: 56, short: "tpt", art: "normal" },
      { dir: "french horn", prefix: "french-horn", name: "French Horn", program: 60, short: "hn", art: "normal" },
      { dir: "trombone", prefix: "trombone", name: "Trombone", program: 57, short: "tbn", art: "normal" },
      { dir: "tuba", prefix: "tuba", name: "Tuba", program: 58, short: "tba", art: "normal" }
    ]
  }
};
const famKey = process.argv[2] ?? "strings";
const fam = FAMILIES[famKey];
if (!fam) { console.error(`알 수 없는 가족: ${famKey} (strings|winds|brass)`); process.exit(1); }
const SRC = path.join(SC, fam.src);
const OUT = path.join(os.homedir(), ".aria/soundfonts", fam.out);
const INSTRUMENTS = fam.instruments;
// 이전 실행의 낡은 wav가 변환 실패를 가리지 않도록 매번 비운다
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const DUR_PREF = ["15", "1", "05", "025"]; // 길수록 좋다 (long/very-long/phrase는 cresc 등이라 제외)

// ── 선별: note → dyn → 최장 duration 파일 ──
function selectFiles(inst) {
  const rx = new RegExp(`^${inst.prefix}_([A-Gs0-9]+)_(025|05|1|15)_(${DYN.join("|")})_${inst.art}\\.mp3$`);
  const byNote = new Map();
  for (const f of fs.readdirSync(path.join(SRC, inst.dir))) {
    const m = rx.exec(f);
    if (!m) continue;
    const midi = noteToMidi(m[1]);
    if (midi === null) continue;
    const cur = byNote.get(midi) ?? {};
    const prev = cur[m[3]];
    if (!prev || DUR_PREF.indexOf(m[2]) < DUR_PREF.indexOf(prev.dur))
      cur[m[3]] = { dur: m[2], file: path.join(SRC, inst.dir, f) };
    byNote.set(midi, cur);
  }
  return byNote;
}

// ── 메인 ──
const t0 = Date.now();
const samples = [], instruments = [], presets = [];
for (const inst of INSTRUMENTS) {
  const byNote = selectFiles(inst);
  const jobs = [];
  for (const [midi, dyns] of byNote)
    for (const [dyn, sel] of Object.entries(dyns))
      jobs.push({ src: sel.file, dst: path.join(TMP, `${inst.short}-${midi}-${dyn}.wav`), midi, dyn });
  const { failed } = await convertAll(jobs);
  console.log(`${inst.name}: 음 ${byNote.size}개, 샘플 ${jobs.length}개 변환${failed ? ` (실패 ${failed})` : ""}`);
  // 변환 실패 레이어는 여기서 제거 — 남겨두면 벨로시티 분할이 어긋나 중간 대역 무음 구멍이 생긴다
  for (const [midi, dyns] of byNote) {
    for (const dyn of Object.keys(dyns))
      if (!fs.existsSync(path.join(TMP, `${inst.short}-${midi}-${dyn}.wav`))) delete dyns[dyn];
    if (!Object.keys(dyns).length) byNote.delete(midi);
  }

  // 1패스: 전 샘플 가공 — 발음이 0.12초도 안 되는 불량 샘플은 여기서 걸러 벨로시티 분할이 재계산되게 한다
  const processed = new Map(); // midi → [{dyn, p, rate}]
  let culled = 0;
  for (const midi of byNote.keys()) {
    const usable = [];
    for (const dyn of DYN.filter(d => byNote.get(midi)[d])) {
      const wav = path.join(TMP, `${inst.short}-${midi}-${dyn}.wav`);
      const { pcm, rate } = readWavMono(wav); // present는 실존 파일에서 재구성됐으므로 없으면 즉시 실패해야 한다
      const p = processSample(pcm, rate, !!inst.oneShot);
      if (p.soundingSec < (inst.oneShot ? 0.05 : 0.12)) { culled++; continue; }
      usable.push({ dyn, p, rate });
    }
    if (usable.length) processed.set(midi, usable);
  }

  // 2패스: 남은 레이어만으로 키/벨로시티 존 구성
  const midis = [...processed.keys()].sort((a, b) => a - b);
  const zones = [];
  let looped = 0;
  for (const [i, midi] of midis.entries()) {
    const keyLo = i === 0 ? Math.max(0, midi - 2) : Math.floor((midis[i - 1] + midi) / 2) + 1;
    const keyHi = i === midis.length - 1 ? Math.min(127, midi + 2) : Math.floor((midi + midis[i + 1]) / 2);
    const layers = processed.get(midi);
    for (const [k, { dyn, p, rate }] of layers.entries()) {
      if (p.loop) looped++;
      samples.push({
        name: `${inst.short}-${midi}-${dyn.slice(0, 4)}`, pcm: p.pcm, sampleRate: rate,
        origPitch: midi, loopStart: p.loopStart, loopEnd: p.loopEnd, loop: p.loop
      });
      zones.push({
        keyLo, keyHi,
        velLo: k === 0 ? 0 : Math.round(127 * k / layers.length) + 1,
        velHi: k === layers.length - 1 ? 127 : Math.round(127 * (k + 1) / layers.length),
        sampleIdx: samples.length - 1, loop: p.loop
      });
    }
  }
  if (culled) console.log(`  발음 ${inst.oneShot ? "0.05" : "0.12"}s 미만 샘플 ${culled}개 제외`);
  console.log(`  존 ${zones.length}개 (루프 생성 ${looped}개)`);
  if (!zones.length) { console.log(`  ⚠ ${inst.name}: 사용 가능한 존이 없어 건너뜀`); inst.midis = []; continue; }
  instruments.push({
    name: inst.name,
    // 원샷은 릴리스를 길게(~1.2s) 잡아 게이트가 짧아도 자연 감쇠가 잘리지 않게 한다
    globalGens: [[34, -9000], [38, inst.oneShot ? 316 : -1586]], // attackVolEnv ~5.6ms, releaseVolEnv 0.4s/1.2s
    zones
  });
  presets.push({ name: inst.name, bank: 0, program: inst.program, instIdx: instruments.length - 1 });
  inst.midis = midis; // 스윕 검증용
}

const res = writeSf2({
  outPath: OUT,
  infoName: fam.info,
  copyright: "Philharmonia Orchestra sound samples — see the official source page for use terms",
  samples, instruments, presets
});
console.log(`\n${fam.out}: ${(res.bytes / 1024 / 1024).toFixed(1)}MB · 샘플 ${res.samples}개 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 전수 스윕 검증: 모든 녹음 음 × vel 4단 — 무음 구멍·지속 끊김·펌핑 검사 ──
// (이전의 4키×2vel 표본 검사는 리뷰에서 확정된 결함을 하나도 잡지 못했다)
const { parseSf2, renderSf2Voice } = await import("../src/sf2.js");
const sf = parseSf2(OUT);
console.log(`파서: 프리셋 ${sf.presets.size}개, 샘플 ${sf.shdr.length}개`);
let checked = 0, nan = 0, silent = 0, dropout = 0, pump = 0;
const worst = [];
for (const inst of INSTRUMENTS) {
  for (const midi of inst.midis) {
    for (const vel of [0.15, 0.45, 0.75, 1.0]) {
      const buf = renderSf2Voice(sf, 0, inst.program, midi, vel, inst.oneShot ? 0.5 : 2.6, 44100);
      checked++;
      if (inst.oneShot) {
        // 원샷: 자연 감쇠가 정상이므로 발음 여부·NaN만 검사
        let s = 0, bad = 0;
        for (let i = 0; i < Math.min(buf.length, 22050); i++) { if (!Number.isFinite(buf[i])) bad++; s += buf[i] * buf[i]; }
        nan += bad;
        if (Math.sqrt(s / 22050) < 1e-4) { silent++; worst.push([`무음 ${inst.short}-${midi} vel${vel}`, -99]); }
        continue;
      }
      const rmsAt = (t, win = 0.3) => {
        let s = 0, c = 0;
        const a = Math.floor(t * 44100), n = Math.floor(win * 44100);
        for (let i = a; i < a + n && i < buf.length; i++) { if (!Number.isFinite(buf[i])) nan++; s += buf[i] * buf[i]; c++; }
        return Math.sqrt(s / (c || 1));
      };
      const early = Math.max(rmsAt(0.15), rmsAt(0.4));
      if (early < 1e-4) { silent++; worst.push([`무음 ${inst.short}-${midi} vel${vel}`, -99]); continue; }
      const late = rmsAt(2.2);
      if (late < early * 0.15) { dropout++; worst.push([`끊김 ${inst.short}-${midi} vel${vel}`, 20 * Math.log10(late / early)]); continue; }
      const wins = [1.0, 1.3, 1.6, 1.9, 2.2].map(t => rmsAt(t));
      const swing = 20 * Math.log10(Math.max(...wins) / (Math.min(...wins) || 1e-9));
      if (swing > 6) { pump++; worst.push([`펌핑 ${inst.short}-${midi} vel${vel}`, swing]); }
    }
  }
}
console.log(`스윕 ${checked}건: 무음 ${silent} · 지속 끊김 ${dropout} · 펌핑(>6dB) ${pump}${nan ? ` · ⚠ NaN ${nan}` : ""}`);
for (const [what, db] of worst.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8))
  console.log(`  ⚠ ${what} (${db.toFixed(1)}dB)`);
