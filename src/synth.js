// aria — 순수 JS 신스 엔진: 곡의 구간을 스테레오 PCM으로 렌더
// 재생(afplay)과 WAV 내보내기가 이 코드를 공유한다.
import { PRESETS, DRUM_KITS, DRUM_PIECES, SF_PRESETS, SF_DRUM_KITS, isDrumPreset, isSfPreset, isSfDrumKit, drumPieces } from "./presets.js";
import { noteToMidi, midiToFreq, beatsPerBar, noteStartBeat, totalBars, tempoSegments, beatToSec } from "./song.js";
import { hashSeed, mulberry32 } from "./rng.js";
import { getSf2, getFont, resolveFont, renderSf2Voice, sf2Available, SF2_PATH } from "./sf2.js";
import { masterChain } from "./master.js";
import { eq3, eqActive } from "./eq.js";

const TAU = Math.PI * 2;

// velocity가 음량에 미치는 기본 폭. 1이면 vel 1~127이 약 42dB, 0.65면 약 9dB.
// (예전에는 0.65/0.6이 코드에 박혀 있어서 velocity만으로는 다이내믹을 만들 수 없었다)
const DEFAULT_VEL_RANGE = 0.65;
const DEFAULT_DRUM_VEL_RANGE = 0.6;
// 좌우 리버브 딜레이 차 — 0이면 잔향이 완전 상관되어 모노처럼 들린다(Freeverb의 stereospread와 같은 역할)
const REVERB_STEREO_SPREAD = 23;
// e808 킷에서 실녹음(GM 킷) 샘플을 섞을 피스와 비율 — 노이즈 합성 심벌은 게임 효과음처럼 들린다.
// 킥·탐·림은 합성 쪽이 개성 있어 그대로 둔다. sf2가 없으면 자동으로 순수 합성 폴백.
const E808_LAYER = {
  hhc: { syn: 0.35, smp: 0.9 }, hho: { syn: 0.35, smp: 0.9 }, shaker: { syn: 0.3, smp: 0.85 },
  snare: { syn: 0.55, smp: 0.75 }, clap: { syn: 0.75, smp: 0.5 },
  ride: { syn: 0.3, smp: 0.85 }, crash: { syn: 0.4, smp: 0.85 }
};

// ---------- 엔벨로프 ----------
// ADSR을 샘플 단위 게인 배열로 미리 계산 (게이트 = 노트 길이)
function envelope(sr, [a, d, s, r], gateSec, len) {
  const g = new Float32Array(len);
  const aN = Math.max(1, (a * sr) | 0), dN = Math.max(1, (d * sr) | 0);
  const gateN = Math.min(len, Math.max(aN, (gateSec * sr) | 0));
  const rN = Math.max(1, (r * sr) | 0);
  for (let i = 0; i < len; i++) {
    let v;
    // 어택은 raised-cosine — 양 끝의 기울기가 0이라 모서리가 없다.
    // 선형 램프는 시작과 정점 양쪽에 꺾임이 생겨 짧은 어택(organ은 4ms)에서 클릭으로 들린다.
    if (i < aN) v = 0.5 - 0.5 * Math.cos(Math.PI * (i / aN));
    else {
      const dd = i - aN;
      // 지수 감쇠 느낌을 위해 decay 곡선을 약간 구부림
      v = dd < dN ? s + (1 - s) * Math.pow(1 - dd / dN, 1.6) : s;
    }
    if (i >= gateN) {
      const rr = (i - gateN) / rN;
      if (rr >= 1) { g[i] = 0; continue; }
      v *= Math.pow(1 - rr, 1.4);
    }
    g[i] = v;
  }
  return g;
}

// 트랙이 아무 값도 지정하지 않았을 때 실제로 쓰이는 음색 값 — GUI가 "기본" 위치를 정직하게
// 표시하려면 이 값이 필요하다. 렌더에서 쓰는 폴백 사슬과 같은 식이라야 하므로 여기 한 곳에 둔다.
// 샘플(sf-*) 프리셋의 attack/release는 사운드폰트 안 보이스마다 달라 정확히 하나로 못 줄인다 —
// 꼬리 길이 계산이 쓰는 것과 같은 근삿값을 내보내고 approx로 표시한다.
export function toneDefaults(presetId) {
  const sfMel = isSfPreset(presetId), sfDrum = isSfDrumKit(presetId);
  const drum = isDrumPreset(presetId);
  const preset = sfMel ? SF_PRESETS[presetId] : sfDrum ? SF_DRUM_KITS[presetId]
    : drum ? DRUM_KITS[presetId] : PRESETS[presetId];
  if (!preset) return null;
  const adsr = preset.params?.adsr;
  return {
    reverb: drum ? (sfDrum ? 0.12 : 0.08) : (preset.reverb ?? 0.2),
    attack: adsr ? adsr[0] : 0.005,
    release: adsr ? adsr[3] : (preset.release ?? 0.3),
    velRange: preset.velRange ?? (drum ? DEFAULT_DRUM_VEL_RANGE : DEFAULT_VEL_RANGE),
    eqLow: 0, eqMid: 0, eqHigh: 0, // EQ는 프리셋이 아니라 트랙이 얹는 것이라 기본은 늘 평탄(0dB)
    vibrato: 0,
    approx: !adsr,        // attack/release가 사운드폰트에서 오는 경우
    ensemble: sfMel,      // 합주 스태킹은 독주 샘플 프리셋에서만 의미가 있다
    // 합성 드럼(renderDrum)은 자체 감쇠 곡선으로 만들어져 attack/release가 닿지 않는다 —
    // GUI가 아무 일도 안 하는 슬라이더를 그리지 않도록 여기서 알려준다
    shape: !drum || sfDrum,
    drum
  };
}

// 게인 램프를 샘플 단위 배율 배열로. 구간 밖은 1이고, 겹치는 램프는 곱해진다.
// dB로 선형 보간하는 이유: 사람 귀는 배수(dB)로 듣는다 — 진폭으로 보간하면 페이드아웃의
// 마지막이 뚝 떨어지는 것처럼 들린다.
function rampEnvelope(ramps, song, segs, startSec, len, sr) {
  const env = new Float32Array(len).fill(1);
  const bpb = beatsPerBar(song);
  for (const g of ramps) {
    const s0 = beatToSec(segs, (g.from - 1) * bpb) - startSec;
    const s1 = beatToSec(segs, g.to * bpb) - startSec; // to마디 끝까지
    const i0 = Math.max(0, Math.round(s0 * sr)), i1 = Math.min(len, Math.round(s1 * sr));
    const span = i1 - i0;
    if (span <= 0) {
      // 구간이 렌더 범위 밖 — 앞이면 끝값, 뒤면 시작값이 그대로 걸려 있어야 이어 듣기가 자연스럽다
      const db = s1 <= 0 ? g.to_db : s0 >= len / sr ? g.db : null;
      if (db !== null) { const m = Math.pow(10, db / 20); for (let i = 0; i < len; i++) env[i] *= m; }
      continue;
    }
    for (let i = 0; i < i0; i++) env[i] *= Math.pow(10, g.db / 20);       // 구간 앞은 시작값 유지
    for (let i = i0; i < i1; i++) env[i] *= Math.pow(10, (g.db + (g.to_db - g.db) * ((i - i0) / span)) / 20);
    for (let i = i1; i < len; i++) env[i] *= Math.pow(10, g.to_db / 20);  // 구간 뒤는 끝값 유지
  }
  return env;
}

// 프리셋의 adsr에 트랙 오버라이드(attack/release)를 얹은 사본
function effectiveAdsr(preset, track) {
  const [a, d, s, r] = preset.params.adsr;
  return [track?.attack ?? a, d, s, track?.release ?? r];
}

function oscSample(wave, phase) {
  switch (wave) {
    case "sine": return Math.sin(phase);
    case "saw": { const p = phase / TAU % 1; return 2 * p - 1; }
    case "square": return Math.sin(phase) >= 0 ? 1 : -1;
    case "triangle": { const p = phase / TAU % 1; return 4 * Math.abs(p - 0.5) - 1; }
    default: return Math.sin(phase);
  }
}

// 음 하나에 걸리는 음높이 변조 배율 — 휘어 오르내림(bend)과 떨림(vibrato)을 함께 만든다.
// 비브라토는 곧바로 시작하지 않고 조금 뒤에 서서히 들어온다: 실제 연주가 그렇고,
// 짧은 음까지 흔들어 놓으면 음정이 불안한 것처럼 들린다.
const VIB_HZ = 5.5, VIB_CENTS = 55, VIB_DELAY = 0.12;
function pitchMod(sr, len, gateN, bend, vib) {
  if (!bend && !vib) return null;
  const mul = new Float32Array(len);
  const w = TAU * VIB_HZ / sr, dN = Math.max(1, VIB_DELAY * sr), gN = Math.max(1, gateN);
  for (let i = 0; i < len; i++) {
    // 벤드는 음이 울리는 동안 목표까지 고르게 이동하고, 그 뒤 여운에서는 도달한 값을 유지한다
    let semis = bend ? bend * Math.min(1, i / gN) : 0;
    if (vib) {
      const on = Math.min(1, Math.max(0, (i - dN) / (dN * 2)));
      semis += vib * (VIB_CENTS / 100) * on * Math.sin(w * i);
    }
    mul[i] = Math.pow(2, semis / 12);
  }
  return mul;
}

// ---------- 멜로디 보이스 ----------
function renderMelodic(preset, midi, vel, gateSec, sr, { track, rng, bend = 0, vib = 0 } = {}) {
  const p = preset.params;
  const adsr = effectiveAdsr(preset, track);
  const rel = adsr[3];
  // 게이트는 어택보다 짧아질 수 없다(envelope의 gateN) — 버퍼도 어택을 반영해야 릴리즈가 잘리지 않는다
  const len = Math.ceil((Math.max(gateSec, adsr[0]) + rel + 0.03) * sr);
  const out = new Float32Array(len);
  const env = envelope(sr, adsr, gateSec, len);
  const f0 = midiToFreq(midi);
  const ks = p.keyscale ? Math.pow(2, ((60 - midi) / 36) * p.keyscale) : 1; // 고음일수록 배음 절제
  const velRange = track?.velRange ?? DEFAULT_VEL_RANGE;
  const velAmp = (1 - velRange) + velRange * vel;
  const pm = pitchMod(sr, len, Math.max(1, (gateSec * sr) | 0), bend, vib);

  if (preset.engine === "fm") {
    const voices = p.voices ?? 1;
    const detune = p.detune ?? 0;
    for (let v = 0; v < voices; v++) {
      const det = voices > 1 ? (v * 2 - 1) * detune : 0;
      const f = f0 * Math.pow(2, det / 1200);
      const cw = TAU * f / sr;
      const ops = p.ops.map(op => ({ w: TAU * f * op.ratio / sr, idx: op.index * ks * (0.5 + 0.5 * vel), dec: op.decay, ph: 0 }));
      let cp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const pmul = pm ? pm[i] : 1;
        let mod = 0;
        for (const op of ops) { mod += op.idx * Math.exp(-t / op.dec) * Math.sin(op.ph); op.ph += op.w * pmul; }
        out[i] += Math.sin(cp + mod) * env[i] / voices;
        cp += cw * pmul;
      }
    }
  } else if (preset.engine === "sub" && p.unison?.voices > 1) {
    // 수퍼쏘 유니즌 — 디튠된 보이스 여러 개를 좌우로 펼친 스테레오 보이스.
    // 단일 톱니파는 그 자체가 칩튠 음색이라, 현대 팝 리드·베이스의 두께는 여기서 나온다.
    const V = p.unison.voices, spread = p.unison.spread ?? 0.7;
    const outL = new Float32Array(len), outR = new Float32Array(len);
    const voices = [];
    for (let v = 0; v < V; v++) {
      const pos = 2 * v / (V - 1) - 1; // -1..1 대칭
      const pan = spread * pos;
      voices.push({
        gL: Math.cos((pan + 1) * Math.PI / 4), gR: Math.sin((pan + 1) * Math.PI / 4),
        oscs: p.oscs.map(o => ({
          wave: o.wave,
          w: TAU * f0 * Math.pow(2, (o.oct ?? 0) + ((o.detune ?? 0) + p.unison.detune * pos) / 1200) / sr,
          level: o.level, ph: (rng ? rng() : 0) * TAU // 자유 위상 — 유니즌의 물결은 위상 무작위에서 온다
        }))
      });
    }
    // 1/√V보다 완만한 정규화 — 무작위 위상 상쇄 탓에 √V 정규화는 유니즌 프리셋을 5dB쯤 묻히게 했다(리뷰 확정)
    const norm = Math.pow(V, -0.4);
    let lpL = 0, lpR = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let xL = 0, xR = 0;
      const pmul = pm ? pm[i] : 1;
      for (const vc of voices) {
        let x = 0;
        for (const o of vc.oscs) { x += oscSample(o.wave, o.ph) * o.level; o.ph += o.w * pmul; }
        xL += x * vc.gL; xR += x * vc.gR;
      }
      const fc = Math.min(sr * 0.45, (p.cutoff + (p.fenv ?? 0) * Math.exp(-t / (p.fdecay ?? 0.2))) * ks);
      const c = 1 - Math.exp(-TAU * fc / sr);
      lpL += c * (xL * norm - lpL); lpR += c * (xR * norm - lpR);
      outL[i] = lpL * env[i]; outR[i] = lpR * env[i];
    }
    const ampU = velAmp * (preset.gain ?? 0.8) * 0.5;
    for (const ch2 of [outL, outR]) {
      if (p.lp) {
        const c = 1 - Math.exp(-TAU * p.lp / sr);
        let s = 0;
        for (let i = 0; i < len; i++) { s += c * (ch2[i] - s); ch2[i] = s; }
      }
      for (let i = 0; i < len; i++) ch2[i] *= ampU;
    }
    return { l: outL, r: outR };
  } else if (preset.engine === "sub") {
    const oscs = p.oscs.map(o => ({
      wave: o.wave,
      w: TAU * f0 * Math.pow(2, (o.oct ?? 0) + (o.detune ?? 0) / 1200) / sr,
      level: o.level, ph: (rng ? rng() : 0) * TAU
    }));
    // 원폴 로우패스 + 필터 엔벨로프
    let lpState = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let x = 0;
      for (const o of oscs) { x += oscSample(o.wave, o.ph) * o.level; o.ph += o.w * (pm ? pm[i] : 1); }
      const fc = Math.min(sr * 0.45, (p.cutoff + (p.fenv ?? 0) * Math.exp(-t / (p.fdecay ?? 0.2))) * ks);
      const c = 1 - Math.exp(-TAU * fc / sr);
      lpState += c * (x - lpState);
      out[i] = lpState * env[i];
    }
  } else { // add
    const parts = p.partials.map(pt => ({ w: TAU * f0 * pt.mult / sr, level: pt.level, ph: 0 }));
    for (let i = 0; i < len; i++) {
      let x = 0;
      for (const pt of parts) { if (pt.w < Math.PI) x += Math.sin(pt.ph) * pt.level; pt.ph += pt.w * (pm ? pm[i] : 1); }
      out[i] = x * env[i];
    }
  }
  // 프리셋 로우패스(음색 다듬기)
  if (p.lp) {
    const c = 1 - Math.exp(-TAU * p.lp / sr);
    let s = 0;
    for (let i = 0; i < len; i++) { s += c * (out[i] - s); out[i] = s; }
  }
  const amp = velAmp * (preset.gain ?? 0.8) * 0.5;
  for (let i = 0; i < len; i++) out[i] *= amp;
  return out;
}

// ---------- 드럼 보이스 ----------
function noiseBuf(len, rng) { const b = new Float32Array(len); for (let i = 0; i < len; i++) b[i] = rng() * 2 - 1; return b; }

function renderDrum(kit, piece, vel, sr, { track, rng = Math.random } = {}) {
  const ch = kit.character;
  const mk = (sec) => new Float32Array(Math.ceil(sec * sr));
  let out;
  const decExp = (i, tau) => Math.exp(-i / (tau * sr));
  switch (piece) {
    case "kick": {
      const long = ch === "e808";
      const dur = long ? 0.7 : ch === "lofi" ? 0.22 : 0.28;
      const f0 = long ? 110 : 140, f1 = long ? 41 : 48, slide = long ? 0.08 : 0.045;
      out = mk(dur);
      let ph = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        const f = f1 + (f0 - f1) * Math.exp(-t / slide);
        ph += TAU * f / sr;
        out[i] = Math.sin(ph) * decExp(i, long ? 0.28 : 0.09) * 1.15
          + (i < sr * 0.004 ? (rng() * 2 - 1) * 0.5 * (1 - i / (sr * 0.004)) : 0);
      }
      break;
    }
    case "snare": {
      const dur = ch === "e808" ? 0.22 : 0.3;
      out = mk(dur);
      let ph = 0, hp = 0;
      const noise = noiseBuf(out.length, rng);
      for (let i = 0; i < out.length; i++) {
        ph += TAU * 185 / sr;
        // 노이즈 하이패스(원폴 차분)
        const hpc = 1 - Math.exp(-TAU * 1800 / sr);
        hp += hpc * (noise[i] - hp);
        const snap = (noise[i] - hp) * decExp(i, ch === "acoustic" ? 0.11 : 0.07) * 0.9;
        const body = Math.sin(ph) * decExp(i, 0.045) * 0.6;
        out[i] = snap + body;
      }
      break;
    }
    case "rim": {
      out = mk(0.06);
      let ph = 0;
      for (let i = 0; i < out.length; i++) { ph += TAU * 1700 / sr; out[i] = (Math.sin(ph) >= 0 ? 1 : -1) * decExp(i, 0.012) * 0.5; }
      break;
    }
    case "clap": {
      out = mk(0.35);
      const noise = noiseBuf(out.length, rng);
      let hp = 0;
      const bursts = [0, 0.012, 0.026];
      for (let i = 0; i < out.length; i++) {
        const hpc = 1 - Math.exp(-TAU * 1200 / sr);
        hp += hpc * (noise[i] - hp);
        const n = noise[i] - hp;
        let e = 0;
        for (const b of bursts) { const d = i - b * sr; if (d >= 0) e = Math.max(e, Math.exp(-d / (0.008 * sr))); }
        e += 0.5 * Math.exp(-Math.max(0, i - 0.03 * sr) / (0.07 * sr)) * (i > 0.03 * sr ? 1 : 0);
        out[i] = n * e * 0.85;
      }
      break;
    }
    case "hhc": case "hho": case "shaker": case "ride": case "crash": {
      const taus = { hhc: 0.035, hho: 0.25, shaker: 0.045, ride: 0.7, crash: 1.1 };
      const cut = { hhc: 7500, hho: 7000, shaker: 5200, ride: 5500, crash: 4500 }[piece];
      const lvl = { hhc: 0.4, hho: 0.42, shaker: 0.3, ride: 0.32, crash: 0.55 }[piece];
      out = mk(taus[piece] * 4);
      const noise = noiseBuf(out.length, rng);
      let hp = 0;
      // 금속성: 사각파 링 두 개를 노이즈에 살짝 섞음
      let p1 = 0, p2 = 0;
      for (let i = 0; i < out.length; i++) {
        p1 += TAU * 5230 / sr; p2 += TAU * 8114 / sr;
        const metal = ((Math.sin(p1) >= 0 ? 1 : -1) + (Math.sin(p2) >= 0 ? 1 : -1)) * 0.18;
        const hpc = 1 - Math.exp(-TAU * cut / sr);
        hp += hpc * ((noise[i] + metal) - hp);
        out[i] = (noise[i] + metal - hp) * decExp(i, taus[piece]) * lvl;
      }
      break;
    }
    case "tom-l": case "tom-m": case "tom-h": {
      const f = { "tom-l": 95, "tom-m": 130, "tom-h": 175 }[piece];
      out = mk(0.35);
      let ph = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        ph += TAU * (f * (1 + 0.4 * Math.exp(-t / 0.03))) / sr;
        out[i] = Math.sin(ph) * decExp(i, 0.12) * 0.8 + (rng() * 2 - 1) * decExp(i, 0.015) * 0.2;
      }
      break;
    }
    default: out = mk(0.05);
  }
  // 킷 캐릭터 후처리
  if (ch === "lofi") {
    let s = 0;
    const c = 1 - Math.exp(-TAU * 6000 / sr);
    for (let i = 0; i < out.length; i++) {
      s += c * (out[i] - s);
      out[i] = Math.round(s * 48) / 48; // 살짝 비트크러시
    }
  }
  const velRange = track?.velRange ?? DEFAULT_DRUM_VEL_RANGE;
  const amp = ((1 - velRange) + velRange * vel) * 0.85;
  for (let i = 0; i < out.length; i++) out[i] *= amp;
  return out;
}

// ---------- 리버브 (Schroeder) ----------
function reverbProcess(input, sr, spread = 0) {
  const scale = sr / 44100;
  // spread만큼 딜레이를 어긋내 좌우 잔향의 상관을 끊는다 — 없으면 잔향이 가운데 뭉쳐 공간이 좁게 들린다
  // 콤 8개 + fb 0.86 → RT60 ≈ 1.5초의 홀 잔향 (기존 4개·0.78은 0.8초짜리 작은 방이라 스케일감이 없었다)
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map(d => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0, filt: 0 }));
  const aps = [556, 441].map(d => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0 }));
  const out = new Float32Array(input.length);
  const fb = 0.86, damp = 0.32, apg = 0.5;
  const pd = Math.round(0.018 * sr); // 프리딜레이 — 직접음과 잔향을 떼어 홀의 크기감을 만든다
  for (let n = 0; n < input.length; n++) {
    const x = input[n];
    let sum = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.filt = y * (1 - damp) + c.filt * damp;
      c.buf[c.i] = x + c.filt * fb;
      c.i = (c.i + 1) % c.buf.length;
      sum += y;
    }
    let s = sum * 0.125;
    for (const a of aps) {
      const y = a.buf[a.i];
      const v = s + y * -apg;
      a.buf[a.i] = v;
      s = y + v * apg;
      a.i = (a.i + 1) % a.buf.length;
    }
    if (n + pd < out.length) out[n + pd] = s;
  }
  return out;
}

// ---------- 메인 렌더 ----------
// fromBar~toBar(포함)를 렌더. 반환: { left, right, sr, duration }
export function renderRange(song, fromBar = 1, toBar = totalBars(song), opts = {}) {
  const sr = opts.sampleRate ?? 44100;
  const bpb = beatsPerBar(song);
  const segs = tempoSegments(song);
  const startBeat = (fromBar - 1) * bpb;
  const startSec = beatToSec(segs, startBeat);
  const rangeSec = beatToSec(segs, toBar * bpb) - startSec;
  // 꼬리는 가장 긴 릴리즈를 담아야 한다 — release를 8초까지 올릴 수 있으므로 1.6초 고정이면 끝이 하드컷된다.
  // 샘플 드럼 킷은 크래시·오픈햇 잔향이 릴리즈 역할을 하므로 킷의 release 메타를 반영한다.
  const maxRel = song.tracks.reduce((m, t) => {
    if (isSfDrumKit(t.preset)) return Math.max(m, SF_DRUM_KITS[t.preset].release ?? 3);
    // e808은 sf2가 있으면 심벌류를 실녹음으로 레이어링 — 그 잔향(크래시 ~2초)도 꼬리에 담아야 한다
    if (isDrumPreset(t.preset)) return DRUM_KITS[t.preset]?.character === "e808" && sf2Available() ? Math.max(m, 2.2) : m;
    return Math.max(m, t.release ?? (isSfPreset(t.preset) ? SF_PRESETS[t.preset].release : PRESETS[t.preset].params.adsr[3]));
  }, 0);
  const tail = opts.tail ?? Math.max(2.2, maxRel + 1.5); // 릴리즈 + 홀 리버브 꼬리(RT60 ≈ 1.5초)
  const len = Math.ceil((rangeSec + tail) * sr);
  const L = new Float32Array(len), R = new Float32Array(len);
  const sendL = new Float32Array(len), sendR = new Float32Array(len);
  // 렌더는 결정적이어야 한다 — 같은 곡을 play와 export가 각각 렌더해도 파형이 같아야 비교·검증이 가능하다.
  // 시드에 제목·bpm 같은 메타데이터를 넣으면 이름만 바꿔도 파형이 통째로 달라지므로 상수에서 출발한다.
  const songSeed = hashSeed("aria");
  // EQ 걸린 트랙만 자기 버퍼에 따로 모았다가 필터를 통과시킨다. 첫 EQ 트랙에서 한 번 잡고 재사용
  let eqL = null, eqR = null;

  // 솔로가 하나라도 켜져 있으면 그 트랙들만 들린다(음소거보다 우선) — 없으면 음소거만 본다
  const soloOn = song.tracks.some(t => t.solo);
  const audible = t => soloOn ? !!t.solo : !t.mute;

  // ── 사이드체인 덕킹 — e808 킥이 멜로디 트랙을 순간적으로 눌러 EDM식 펌핑을 만든다 ──
  const duck = new Float32Array(len).fill(1);
  for (const track of song.tracks) {
    if (!audible(track)) continue;
    if (DRUM_KITS[track.preset]?.character !== "e808") continue;
    const A = Math.max(1, Math.floor(0.006 * sr)), R2 = Math.floor(0.24 * sr);
    for (const note of track.notes) {
      if (note.pitch !== "kick" || note.bar < fromBar || note.bar > toBar) continue;
      const off = Math.round((beatToSec(segs, noteStartBeat(song, note)) - startSec) * sr);
      if (off < 0 || off >= len) continue;
      const depth = 0.42 * Math.min(1, note.vel / 100);
      for (let i = 0; i < A + R2 && off + i < len; i++) {
        const d = i < A ? depth * (i / A) : depth * Math.exp(-(i - A) / (0.075 * sr));
        const g = 1 - d;
        if (g < duck[off + i]) duck[off + i] = g;
      }
    }
  }

  for (const track of song.tracks) {
    // 스템 모드(opts.stem=트랙명): 해당 트랙 하나만, 음소거 여부와 무관하게 렌더한다 —
    // 브라우저가 트랙별 버퍼를 캐시해 두고 음소거·볼륨을 실시간으로 섞는 "즉시 믹스"의 재료
    if (opts.stem !== undefined ? track.name !== opts.stem : !audible(track)) continue;
    const sfMel = isSfPreset(track.preset), sfDrum = isSfDrumKit(track.preset);
    const drum = isDrumPreset(track.preset);
    const preset = sfMel ? SF_PRESETS[track.preset]
      : sfDrum ? SF_DRUM_KITS[track.preset]
      : drum ? DRUM_KITS[track.preset] : PRESETS[track.preset];
    // 트랙별 폰트 결정 — 전용 폰트(예: Salamander) 우선, 없으면 default.sf2, 그것도 없으면 명확한 에러
    let font = null;
    if (sfMel || sfDrum) {
      font = resolveFont(preset);
      if (!font)
        throw new Error(`샘플 프리셋(${track.preset})을 쓰려면 사운드폰트가 필요합니다 — ${SF2_PATH} 위치에 GM .sf2 파일을 두세요 (README의 SoundFont 절 참고)`);
    }
    const revAmt = track.reverb ?? (drum ? (sfDrum ? 0.12 : 0.08) : (preset.reverb ?? 0.2));
    // 트랙 EQ는 채널 스트립이므로 리버브 센드보다 앞이다 — 밝게 만든 트랙은 잔향도 같이 밝아져야
    // 직접음과 꼬리의 음색이 갈라지지 않는다. (센드 뒤는 구조상 불가능하기도 하다: 센드는 공용 버스다)
    const eq = { low: track.eqLow, mid: track.eqMid, high: track.eqHigh };
    const eqOn = eqActive(eq);
    if (eqOn && !eqL) { eqL = new Float32Array(len); eqR = new Float32Array(len); }
    const tL = eqOn ? eqL.fill(0) : L, tR = eqOn ? eqR.fill(0) : R;
    const sendAmt = eqOn ? 0 : revAmt; // EQ 트랙의 센드는 필터를 지난 뒤에 뽑는다
    // 게인 램프(페이드인·아웃)는 샘플 단위로 건다 — 노트 단위로 걸면 길게 끄는 화음 하나짜리
    // 엔딩이 "조금 작아진 채 그대로" 끝나 버려 페이드아웃이 되지 않는다.
    // 상수 구간 게인은 예전 그대로 노트 단위다(기존 곡의 소리가 바뀌면 안 된다).
    const ramps = (track.gains ?? []).filter(g => g.to_db !== undefined);
    const rampEnv = ramps.length ? rampEnvelope(ramps, song, segs, startSec, len, sr) : null;
    // 등파워 팬
    const panL = Math.cos((track.pan + 1) * Math.PI / 4);
    const panR = Math.sin((track.pan + 1) * Math.PI / 4);
    // 이름이 아니라 seed로 고정한다 — 트랙 이름을 바꿔도 소리가 달라지지 않는다
    const trackSeed = hashSeed(songSeed, track.seed ?? track.name, track.preset);
    // 햇 초크 시각 — GM 킷은 hhc가 hho를 끊는 exclusiveClass에 의존하는데 우리 파서는 그걸 안 읽는다.
    // 대신 렌더에서 재현: hho는 같은 트랙의 다음 햇 이벤트 시각에서 페이드아웃 (리뷰 확정 결함: 심벌 워시)
    const hatTimes = drum ? track.notes
      .filter(n => (n.pitch === "hhc" || n.pitch === "hho") && n.bar >= fromBar && n.bar <= toBar)
      .map(n => beatToSec(segs, noteStartBeat(song, n)) - startSec)
      .sort((a, b) => a - b) : null;
    for (const note of track.notes) {
      if (note.bar < fromBar || note.bar > toBar) continue;
      const noteBeat = noteStartBeat(song, note);
      const t0 = beatToSec(segs, noteBeat) - startSec;
      const offset = Math.round(t0 * sr);
      if (offset >= len) continue;
      // 게이트 길이는 템포 변화를 통과한 실제 초 — rit. 중이면 같은 dur라도 더 길게 울린다
      const gateSec = beatToSec(segs, noteBeat + note.dur) - beatToSec(segs, noteBeat);
      const vel = note.vel / 127;
      const rng = mulberry32(hashSeed(trackSeed, note.bar, note.beat, note.pitch, note.vel, note.dur));
      // 휘어 오르내림(노트별)과 떨림(트랙별) — 둘 다 없으면 배열도 안 만든다
      const bend = drum ? 0 : (note.bend ?? 0);
      const vib = drum ? 0 : (track.vibrato ?? 0);
      const pmLen = Math.ceil((gateSec + 9) * sr); // 어떤 보이스 버퍼보다 길게 — 남는 뒤쪽은 안 읽힌다
      const pmod = pitchMod(sr, pmLen, Math.max(1, (gateSec * sr) | 0), bend, vib);
      let buf;
      if (sfMel || sfDrum) {
        // 합주 스태킹: 독주 샘플을 미세 디튠(±수 센트)·지연(수십 ms)으로 겹쳐 파트처럼 —
        // 독주자 1명이 투티를 연기하는 것이 오케스트라 질감이 얇았던 첫 번째 이유였다
        const ensN = sfMel ? Math.min(4, Math.max(1, Math.round(track.ensemble ?? 1))) : 1;
        const key = sfDrum ? drumPieces(track.preset)[note.pitch] : noteToMidi(note.pitch);
        if (ensN > 1) {
          const DET = [0, 8, -7, 13], DLY = [0, 0.013, 0.021, 0.034];
          const parts = [];
          let maxLen = 0;
          for (let e = 0; e < ensN; e++) {
            const pb = renderSf2Voice(font, 0, preset.gm, key, vel, gateSec, sr, { track, detuneCents: DET[e], pitchMod: pmod });
            const dly = Math.round(DLY[e] * sr);
            parts.push({ pb, dly });
            maxLen = Math.max(maxLen, pb.length + dly);
          }
          buf = new Float32Array(maxLen);
          const g = 1 / Math.sqrt(ensN);
          for (const { pb, dly } of parts) for (let i = 0; i < pb.length; i++) buf[i + dly] += pb[i] * g;
        } else {
          buf = renderSf2Voice(font, sfDrum ? preset.bank : 0, sfDrum ? preset.program : preset.gm, key, vel, gateSec, sr, { track, pitchMod: pmod });
        }
        // 샘플에도 신스와 같은 velocity 다이내믹·프리셋 게인을 적용한다
        const velRange = track.velRange ?? preset.velRange ?? (sfDrum ? DEFAULT_DRUM_VEL_RANGE : DEFAULT_VEL_RANGE);
        const amp = ((1 - velRange) + velRange * vel) * (preset.gain ?? 1) * 0.9;
        for (let i = 0; i < buf.length; i++) buf[i] *= amp;
      } else if (drum) {
        buf = renderDrum(preset, note.pitch, vel, sr, { track, rng });
        // e808 심벌·스네어에 실녹음(GM 킷) 레이어 — 노이즈 합성만으로는 장난감 소리가 난다
        const layer = preset.character === "e808" ? E808_LAYER[note.pitch] : null;
        // 레이어 소스: Salamander 실녹음 킷 우선(펀치·벨로시티 층), 없으면 GM 킷 폴백
        const lfont = layer ? (getFont("salamander-kit.sf2") ?? getSf2()) : null;
        if (lfont) {
          const sb = renderSf2Voice(lfont, 128, 0, DRUM_PIECES[note.pitch], vel, gateSec, sr, { track });
          const velRange = track.velRange ?? DEFAULT_DRUM_VEL_RANGE;
          const amp = ((1 - velRange) + velRange * vel) * 0.85;
          const merged = new Float32Array(Math.max(buf.length, sb.length));
          for (let i = 0; i < merged.length; i++)
            merged[i] = (i < buf.length ? buf[i] * layer.syn : 0) + (i < sb.length ? sb[i] * amp * layer.smp : 0);
          buf = merged;
        }
      } else {
        buf = renderMelodic(preset, noteToMidi(note.pitch), vel, gateSec, sr, { track, rng, bend, vib });
      }
      // 오픈햇 초크 — 다음 햇(hhc/hho)이 오면 15ms 페이드로 끊는다
      if (drum && note.pitch === "hho" && hatTimes) {
        const next = hatTimes.find(t2 => t2 > t0 + 0.005);
        if (next !== undefined) {
          const cap = Math.max(1, Math.floor((next - t0) * sr)), fade = Math.floor(0.015 * sr);
          if (buf.length > cap + fade) {
            for (let i = 0; i < fade; i++) buf[cap + i] *= 1 - i / fade;
            buf = buf.subarray(0, cap + fade);
          }
        }
      }
      // 구간 게인 — 이 노트가 게인 구간 안이면 dB만큼 조절 (겹치는 구간은 곱으로 누적)
      // 스템은 트랙 볼륨을 굽지 않는다(=1) — 브라우저가 실시간 게인으로 조절한다. 구간 게인은 악보 해석이라 굽는다
      let vol = opts.stem !== undefined ? 1 : track.volume;
      if (track.gains) for (const g of track.gains)
        if (g.to_db === undefined && note.bar >= g.from && note.bar <= g.to) vol *= Math.pow(10, g.db / 20);
      if (buf.l) { // 스테레오 보이스(유니즌) — 트랙 팬은 밸런스로 얹는다
        const bl = buf.l, br = buf.r;
        const gl = panL * Math.SQRT2 * vol, gr = panR * Math.SQRT2 * vol;
        const nmax = Math.min(bl.length, len - offset);
        for (let i = 0; i < nmax; i++) {
          const j = offset + i;
          const dk = drum ? 1 : duck[j];
          const rg = rampEnv ? rampEnv[j] : 1;
          const sL = bl[i] * gl * dk * rg, sR = br[i] * gr * dk * rg;
          tL[j] += sL; tR[j] += sR;
          sendL[j] += sL * sendAmt; sendR[j] += sR * sendAmt;
        }
      } else {
        const nmax = Math.min(buf.length, len - offset);
        for (let i = 0; i < nmax; i++) {
          const j = offset + i;
          const s = buf[i] * vol * (drum ? 1 : duck[j]) * (rampEnv ? rampEnv[j] : 1);
          tL[j] += s * panL; tR[j] += s * panR;
          sendL[j] += s * panL * sendAmt; sendR[j] += s * panR * sendAmt;
        }
      }
    }
    // 트랙 버퍼에 EQ를 걸고 나서 마스터와 리버브 센드로 내보낸다
    if (eqOn) {
      eq3(tL, sr, eq); eq3(tR, sr, eq);
      for (let i = 0; i < len; i++) {
        L[i] += tL[i]; R[i] += tR[i];
        sendL[i] += tL[i] * revAmt; sendR[i] += tR[i] * revAmt;
      }
    }
  }
  const wetL = reverbProcess(sendL, sr, 0), wetR = reverbProcess(sendR, sr, REVERB_STEREO_SPREAD);
  // 마스터 단은 master.js 한 곳에만 둔다 — 스템도 같은 함수를 통과해야 "스템을 다 더한 것"과
  // "완성 믹스"가 어긋나지 않는다. 스템 모드는 비선형(글루 컴프·소프트클립)만 끈 선형 경로다
  // (브라우저가 실시간으로 섞으면서 자기 쪽 컴프로 근사한다).
  // 리미터는 기본으로 켠다 — 없으면 소리가 쌓일 때 소프트클립이 물려 왜곡이 섞였다.
  // 리미터는 넘칠 것 같은 지점을 미리 눌러 그 왜곡 자체를 없앤다(얼마나 눌렀는지는 리포트에 남는다).
  const master = masterChain(L, R, sr, opts.stem !== undefined
    ? { wetL, wetR, comp: false, softClip: false }
    : { wetL, wetR, limiter: true, ...opts.master });
  return { left: L, right: R, sr, duration: len / sr, rangeSec, master };
}

// ---------- WAV ----------
export function wavBuffer(left, right, sr) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), 46 + i * 4);
  }
  return buf;
}
