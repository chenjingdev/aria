// aria — 외부 샘플러 뒤에서 쓰는 공용 믹싱·WAV 도우미.
// 악기 음원은 src/spessa-engine.js가 재생한다. 이 파일은 파형이나 SoundFont 보이스를
// 만들지 않고, UI 기본값·구간 게인·공간 잔향·파일 포장만 담당한다.
import { SF_PRESETS, SF_DRUM_KITS, isSfPreset, isSfDrumKit } from "./presets.js";
import { beatsPerBar, beatToSec } from "./song.js";

const DEFAULT_VEL_RANGE = 0.65;
const DEFAULT_DRUM_VEL_RANGE = 0.6;

// 트랙이 따로 지정하지 않았을 때 UI와 외부 샘플러 경로가 공유하는 값.
export function toneDefaults(presetId) {
  const sfMel = isSfPreset(presetId), sfDrum = isSfDrumKit(presetId);
  const preset = sfMel ? SF_PRESETS[presetId] : sfDrum ? SF_DRUM_KITS[presetId] : null;
  if (!preset) return null;
  return {
    reverb: sfDrum ? 0.12 : (preset.reverb ?? 0.2),
    velRange: preset.velRange ?? (sfDrum ? DEFAULT_DRUM_VEL_RANGE : DEFAULT_VEL_RANGE),
    eqLow: 0, eqMid: 0, eqHigh: 0,
    drum: sfDrum
  };
}

// 구간별 dB 램프를 샘플 단위 배율로 바꾼다. 구간 밖은 양 끝값을 유지하고 겹침은 곱한다.
export function rampEnvelope(ramps, song, segs, startSec, len, sr) {
  const env = new Float32Array(len).fill(1);
  const bpb = beatsPerBar(song);
  for (const g of ramps) {
    const s0 = beatToSec(segs, (g.from - 1) * bpb) - startSec;
    const s1 = beatToSec(segs, g.to * bpb) - startSec;
    const i0 = Math.max(0, Math.round(s0 * sr)), i1 = Math.min(len, Math.round(s1 * sr));
    const span = i1 - i0;
    if (span <= 0) {
      const db = s1 <= 0 ? g.to_db : s0 >= len / sr ? g.db : null;
      if (db !== null) {
        const m = Math.pow(10, db / 20);
        for (let i = 0; i < len; i++) env[i] *= m;
      }
      continue;
    }
    for (let i = 0; i < i0; i++) env[i] *= Math.pow(10, g.db / 20);
    for (let i = i0; i < i1; i++)
      env[i] *= Math.pow(10, (g.db + (g.to_db - g.db) * ((i - i0) / span)) / 20);
    for (let i = i1; i < len; i++) env[i] *= Math.pow(10, g.to_db / 20);
  }
  return env;
}

// 공용 홀 리버브. 음원 생성기가 아니라 여러 외부 악기를 섞는 후단 단계다.
export function reverbProcess(input, sr, spread = 0) {
  const scale = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
    .map(d => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0, filt: 0 }));
  const aps = [556, 441].map(d => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0 }));
  const out = new Float32Array(input.length);
  const fb = 0.86, damp = 0.32, apg = 0.5;
  const predelay = Math.round(0.018 * sr);
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
    let signal = sum * 0.125;
    for (const a of aps) {
      const y = a.buf[a.i];
      const v = signal - y * apg;
      a.buf[a.i] = v;
      signal = y + v * apg;
      a.i = (a.i + 1) % a.buf.length;
    }
    if (n + predelay < out.length) out[n + predelay] = signal;
  }
  return out;
}

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
