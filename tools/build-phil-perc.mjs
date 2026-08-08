// 필하모니아 타악 샘플 → phil-perc.sf2 (오케스트라 퍼커션 킷, bank 128 program 0)
// 선율 파이프라인과 달리: 무음정(파일명 note 필드가 빔), 피스별 주법 선택, 키 하나에 원샷 매핑.
// 셈여림 여러 개가 있으면 벨로시티 레이어로 쌓는다. 톰은 한 샘플을 ±피치로 3키(l/m/h)에 펼친다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeSf2 } from "./sf2write.mjs";
import { DYN, convertAll, readWavMono, processSample } from "./phil-lib.mjs";

const SC = process.env.ARIA_LEGACY_SAMPLE_ROOT;
if (!SC) throw new Error("ARIA_LEGACY_SAMPLE_ROOT가 필요합니다 — 이 도구는 기존 축소 SF2를 재현하는 legacy builder입니다. 전체 팩은 tools/prepare-philharmonia-sfz.mjs를 사용하세요");
const SRC = path.join(SC, "phil/Percussion/Percussion");
const TMP = path.join(SC, "phil/wav-perc");
const OUT = path.join(os.homedir(), ".aria/soundfonts/phil-perc.sf2");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ring: 울림이 긴 악기 — 긴 녹음을 우선 선택. arts: 앞에서부터 파일이 있는 첫 주법 사용.
const PIECES = [
  { key: 36, name: "kick",       dir: "bass drum",        prefix: "bass-drum",        arts: ["bass-drum-mallet"] },
  { key: 38, name: "snare",      dir: "snare drum",       prefix: "snare-drum",       arts: ["with-snares"] },
  { key: 47, name: "tom",        dir: "tom-toms",         prefix: "tom-toms",         arts: ["struck-singly"], tomSpread: true },
  { key: 49, name: "crash",      dir: "clash cymbals",    prefix: "clash-cymbals",    arts: ["undamped", "struck-together"], ring: true },
  { key: 51, name: "ride",       dir: "suspended cymbal", prefix: "suspended-cymbal", arts: ["vibe-mallet-undamped"], ring: true },
  { key: 52, name: "tamtam",     dir: "tam-tam",          prefix: "tam-tam",          arts: ["undamped"], ring: true },
  { key: 54, name: "tambourine", dir: "tambourine",       prefix: "tambourine",       arts: ["hand"] },
  { key: 56, name: "cowbell",    dir: "cowbell",          prefix: "cowbell",          arts: ["undamped"] },
  { key: 67, name: "agogo",      dir: "agogo bells",      prefix: "agogo-bells",      arts: ["struck-singly"] },
  { key: 69, name: "cabasa",     dir: "cabasa",           prefix: "cabasa",           arts: ["effect"] },
  { key: 73, name: "guiro",      dir: "guiro",            prefix: "guiro",            arts: ["scraped"] },
  { key: 76, name: "woodblock",  dir: "woodblock",        prefix: "woodblock",        arts: ["struck-singly"] },
  { key: 81, name: "triangle",   dir: "triangle",         prefix: "triangle",         arts: ["struck-singly"], ring: true },
  { key: 83, name: "sleigh",     dir: "sleigh bells",     prefix: "sleigh-bells",     arts: ["shaken"] },
  { key: 85, name: "castanets",  dir: "castanets",        prefix: "castanets",        arts: ["struck-singly"] }
];

// 피스별 파일 선별: dyn → 최적 duration 파일 (ring이면 긴 쪽, 아니면 1박 근처 우선)
function selectPiece(pc) {
  const durPref = pc.ring ? ["long", "15", "1", "05", "025"] : ["1", "05", "025", "15", "long"];
  for (const art of pc.arts) {
    const rx = new RegExp(`^${pc.prefix}__(${durPref.join("|")})_(${DYN.join("|")})_${art}\\.mp3$`);
    const byDyn = {};
    for (const f of fs.readdirSync(path.join(SRC, pc.dir))) {
      const m = rx.exec(f);
      if (!m) continue;
      const prev = byDyn[m[2]];
      if (!prev || durPref.indexOf(m[1]) < durPref.indexOf(prev.dur))
        byDyn[m[2]] = { dur: m[1], file: path.join(SRC, pc.dir, f) };
    }
    if (Object.keys(byDyn).length) return byDyn;
  }
  return {};
}

const t0 = Date.now();
const samples = [], zones = [];
const kitPieces = []; // 프리셋 등록용 요약
for (const pc of PIECES) {
  const byDyn = selectPiece(pc);
  const dyns = DYN.filter(d => byDyn[d]);
  if (!dyns.length) { console.log(`⚠ ${pc.name}: 파일 없음 — 건너뜀`); continue; }
  const jobs = dyns.map(d => ({ src: byDyn[d].file, dst: path.join(TMP, `${pc.name}-${d}.wav`) }));
  await convertAll(jobs);
  const layers = [];
  for (const d of dyns) {
    const wav = path.join(TMP, `${pc.name}-${d}.wav`);
    if (!fs.existsSync(wav)) continue;
    const { pcm, rate } = readWavMono(wav);
    const p = processSample(pcm, rate, true); // 전부 원샷
    if (p.soundingSec < 0.02) continue;
    layers.push({ dyn: d, p, rate });
  }
  if (!layers.length) { console.log(`⚠ ${pc.name}: 사용 가능 샘플 없음`); continue; }
  // 톰: 같은 샘플을 3키에 피치만 바꿔 복제 (tom-l 43 = -4반음, tom-m 47 = 원음, tom-h 50 = +3반음)
  const targets = pc.tomSpread
    ? [{ key: 43, orig: 47 + 4 }, { key: 47, orig: 47 }, { key: 50, orig: 50 - 3 }]
    : [{ key: pc.key, orig: pc.key }];
  for (const t of targets) {
    for (const [k, { dyn, p, rate }] of layers.entries()) {
      samples.push({
        name: `${pc.name}${t.key}-${dyn.slice(0, 4)}`, pcm: p.pcm, sampleRate: rate,
        origPitch: t.orig, loopStart: 0, loopEnd: p.pcm.length - 1, loop: false
      });
      zones.push({
        keyLo: t.key, keyHi: t.key,
        velLo: k === 0 ? 0 : Math.round(127 * k / layers.length) + 1,
        velHi: k === layers.length - 1 ? 127 : Math.round(127 * (k + 1) / layers.length),
        sampleIdx: samples.length - 1, loop: false
      });
    }
  }
  kitPieces.push(pc.tomSpread ? "tom-l/m/h" : pc.name);
  console.log(`${pc.name}: 레이어 ${layers.length}개 (${dyns.join(", ")})`);
}

const instruments = [{
  name: "Orch Kit",
  globalGens: [[34, -9000], [38, 3102]], // attack ~5.6ms, release ~6s — 심벌·탐탐 울림을 자르지 않게
  zones
}];
const presets = [{ name: "Orch Percussion", bank: 128, program: 0, instIdx: 0 }];
const res = writeSf2({
  outPath: OUT,
  infoName: "Philharmonia Percussion",
  copyright: "Philharmonia Orchestra sound samples — see the official source page for use terms",
  samples, instruments, presets
});
console.log(`\nphil-perc.sf2: ${(res.bytes / 1024 / 1024).toFixed(1)}MB · 샘플 ${res.samples}개 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`피스: ${kitPieces.join(", ")}`);

// ── 스윕: 전 키 × vel 3단 발음 확인 ──
const { openSf2Checker } = await import("./sf2-check.mjs");
const checker = openSf2Checker(OUT);
let checked = 0, silent = 0, nan = 0;
const keys = [...new Set(zones.map(z => z.keyLo))];
try {
  for (const key of keys) {
    for (const vel of [0.3, 0.7, 1.0]) {
      const buf = checker.render({ bank: 128, program: 0, drum: true, key, velocity: vel });
      checked++;
      let s = 0;
      for (let i = 0; i < Math.min(buf.length, 22050); i++) { if (!Number.isFinite(buf[i])) nan++; s += buf[i] * buf[i]; }
      if (Math.sqrt(s / 22050) < 1e-4) { silent++; console.log(`  ⚠ 무음 key ${key} vel${vel}`); }
    }
  }
} finally {
  checker.close();
}
console.log(`스윕 ${checked}건: 무음 ${silent}${nan ? ` · ⚠ NaN ${nan}` : ""}`);
