// aria — 설치된 SoundFont 악기를 곡의 스테레오 PCM으로 렌더한다.
// Aria는 파형을 직접 합성하지 않는다. 재생(afplay)과 WAV 내보내기가 이 경로를 공유한다.
import { SF_PRESETS, SF_DRUM_KITS, isDrumPreset, isSfPreset, isSfDrumKit, drumPieces } from "./presets.js";
import { noteToMidi, beatsPerBar, noteStartBeat, totalBars, tempoSegments, beatToSec } from "./song.js";
import { resolveFont, renderSf2Voice, requiredFontName } from "./sf2.js";
import { masterChain } from "./master.js";
import { eq3, eqActive } from "./eq.js";

const TAU = Math.PI * 2;
const DEFAULT_VEL_RANGE = 0.65;
const DEFAULT_DRUM_VEL_RANGE = 0.6;
const REVERB_STEREO_SPREAD = 23;

// 트랙이 값을 따로 지정하지 않았을 때 실제로 쓰이는 SoundFont 음색 값.
export function toneDefaults(presetId) {
  const sfMel = isSfPreset(presetId), sfDrum = isSfDrumKit(presetId);
  const preset = sfMel ? SF_PRESETS[presetId] : sfDrum ? SF_DRUM_KITS[presetId] : null;
  if (!preset) return null;
  return {
    reverb: sfDrum ? 0.12 : (preset.reverb ?? 0.2),
    attack: 0.005,
    release: preset.release ?? 0.3,
    velRange: preset.velRange ?? (sfDrum ? DEFAULT_DRUM_VEL_RANGE : DEFAULT_VEL_RANGE),
    eqLow: 0, eqMid: 0, eqHigh: 0,
    vibrato: 0,
    approx: true,
    ensemble: sfMel,
    shape: true,
    drum: sfDrum
  };
}

// 구간별 dB 램프를 샘플 단위 배율로 바꾼다. 구간 밖은 양 끝값을 유지하고 겹침은 곱한다.
function rampEnvelope(ramps, song, segs, startSec, len, sr) {
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

// SoundFont 샘플 재생 속도에 곱할 pitch 곡선. 벤드와 비브라토는 샘플 악기 표현 기능이다.
const VIB_HZ = 5.5, VIB_CENTS = 55, VIB_DELAY = 0.12;
function pitchMod(sr, gateN, bend, vib) {
  if (!bend && !vib) return null;
  const w = TAU * VIB_HZ / sr, dN = Math.max(1, VIB_DELAY * sr), gN = Math.max(1, gateN);
  // 보이스의 실제 길이는 SoundFont 존의 attack/release에 따라 달라진다. 고정 길이 배열을
  // 미리 만들면 긴 꼬리에서 끝을 넘어 NaN이 되므로, 필요한 샘플 인덱스를 즉시 계산한다.
  return i => {
    let semis = bend ? bend * Math.min(1, i / gN) : 0;
    if (vib) {
      const on = Math.min(1, Math.max(0, (i - dN) / (dN * 2)));
      semis += vib * (VIB_CENTS / 100) * on * Math.sin(w * i);
    }
    return Math.pow(2, semis / 12);
  };
}

// 공용 홀 리버브. 음원 생성기가 아니라 여러 외부 악기를 섞는 믹싱 단계다.
function reverbProcess(input, sr, spread = 0) {
  const scale = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
    .map(d => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0, filt: 0 }));
  const aps = [556, 441].map(d => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0 }));
  const out = new Float32Array(input.length);
  const fb = 0.86, damp = 0.32, apg = 0.5;
  const pd = Math.round(0.018 * sr);
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

// fromBar~toBar(포함)를 외부 SoundFont만으로 렌더한다.
export function renderRange(song, fromBar = 1, toBar = totalBars(song), opts = {}) {
  const sr = opts.sampleRate ?? 44100;
  const bpb = beatsPerBar(song);
  const segs = tempoSegments(song);
  const startBeat = (fromBar - 1) * bpb;
  const startSec = beatToSec(segs, startBeat);
  const rangeSec = beatToSec(segs, toBar * bpb) - startSec;
  const maxRel = song.tracks.reduce((m, t) => {
    const preset = isSfDrumKit(t.preset) ? SF_DRUM_KITS[t.preset] : SF_PRESETS[t.preset];
    return Math.max(m, t.release ?? preset?.release ?? 0.3);
  }, 0);
  const tail = opts.tail ?? Math.max(2.2, maxRel + 1.5);
  const len = Math.ceil((rangeSec + tail) * sr);
  const L = new Float32Array(len), R = new Float32Array(len);
  const sendL = new Float32Array(len), sendR = new Float32Array(len);
  let eqL = null, eqR = null;

  const soloOn = song.tracks.some(t => t.solo);
  const audible = t => soloOn ? !!t.solo : !t.mute;

  for (const track of song.tracks) {
    if (opts.stem !== undefined ? track.name !== opts.stem : !audible(track)) continue;
    const sfMel = isSfPreset(track.preset), sfDrum = isSfDrumKit(track.preset);
    if (!sfMel && !sfDrum) throw new Error(`지원하지 않는 프리셋 ${track.preset} — SoundFont 악기만 사용할 수 있습니다`);
    const drum = isDrumPreset(track.preset);
    const preset = sfDrum ? SF_DRUM_KITS[track.preset] : SF_PRESETS[track.preset];
    const font = resolveFont(preset);
    if (!font)
      throw new Error(`트랙 "${track.name}"의 음원 ${requiredFontName(preset)}이 설치되지 않았거나 손상되었습니다 — 다른 음원으로 자동 대체하지 않았습니다`);

    const revAmt = track.reverb ?? (sfDrum ? 0.12 : (preset.reverb ?? 0.2));
    const eq = { low: track.eqLow, mid: track.eqMid, high: track.eqHigh };
    const eqOn = eqActive(eq);
    if (eqOn && !eqL) { eqL = new Float32Array(len); eqR = new Float32Array(len); }
    const tL = eqOn ? eqL.fill(0) : L, tR = eqOn ? eqR.fill(0) : R;
    const sendAmt = eqOn ? 0 : revAmt;
    const ramps = (track.gains ?? []).filter(g => g.to_db !== undefined);
    const rampEnv = ramps.length ? rampEnvelope(ramps, song, segs, startSec, len, sr) : null;
    const panL = Math.cos((track.pan + 1) * Math.PI / 4);
    const panR = Math.sin((track.pan + 1) * Math.PI / 4);
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
      const gateSec = beatToSec(segs, noteBeat + note.dur) - beatToSec(segs, noteBeat);
      const vel = note.vel / 127;
      const bend = drum ? 0 : (note.bend ?? 0);
      const vib = drum ? 0 : (track.vibrato ?? 0);
      const pmod = pitchMod(sr, Math.max(1, (gateSec * sr) | 0), bend, vib);
      const key = sfDrum ? drumPieces(track.preset)[note.pitch] : noteToMidi(note.pitch);
      if (key === undefined || key === null)
        throw new Error(`트랙 "${track.name}"의 음 ${note.pitch}을 ${track.preset}에서 찾을 수 없습니다`);

      const ensN = sfMel ? Math.min(4, Math.max(1, Math.round(track.ensemble ?? 1))) : 1;
      let buf;
      if (ensN > 1) {
        const DET = [0, 8, -7, 13], DLY = [0, 0.013, 0.021, 0.034];
        const parts = [];
        let maxLen = 0;
        for (let e = 0; e < ensN; e++) {
          const pb = renderSf2Voice(font, 0, preset.program ?? preset.gm, key, vel, gateSec, sr,
            { track, detuneCents: DET[e], pitchMod: pmod });
          const dly = Math.round(DLY[e] * sr);
          parts.push({ pb, dly });
          maxLen = Math.max(maxLen, pb.length + dly);
        }
        buf = new Float32Array(maxLen);
        const g = 1 / Math.sqrt(ensN);
        for (const { pb, dly } of parts)
          for (let i = 0; i < pb.length; i++) buf[i + dly] += pb[i] * g;
      } else {
        buf = renderSf2Voice(font, sfDrum ? preset.bank : 0, sfDrum ? preset.program : (preset.program ?? preset.gm),
          key, vel, gateSec, sr, { track, pitchMod: pmod });
      }

      const velRange = track.velRange ?? preset.velRange ?? (sfDrum ? DEFAULT_DRUM_VEL_RANGE : DEFAULT_VEL_RANGE);
      const amp = ((1 - velRange) + velRange * vel) * (preset.gain ?? 1) * 0.9;
      for (let i = 0; i < buf.length; i++) buf[i] *= amp;

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

      let vol = opts.stem !== undefined ? 1 : track.volume;
      if (track.gains) for (const g of track.gains)
        if (g.to_db === undefined && note.bar >= g.from && note.bar <= g.to)
          vol *= Math.pow(10, g.db / 20);
      const nmax = Math.min(buf.length, len - offset);
      for (let i = 0; i < nmax; i++) {
        const j = offset + i;
        const s = buf[i] * vol * (rampEnv ? rampEnv[j] : 1);
        tL[j] += s * panL; tR[j] += s * panR;
        sendL[j] += s * panL * sendAmt; sendR[j] += s * panR * sendAmt;
      }
    }

    if (eqOn) {
      eq3(tL, sr, eq); eq3(tR, sr, eq);
      for (let i = 0; i < len; i++) {
        L[i] += tL[i]; R[i] += tR[i];
        sendL[i] += tL[i] * revAmt; sendR[i] += tR[i] * revAmt;
      }
    }
  }

  const wetL = reverbProcess(sendL, sr, 0), wetR = reverbProcess(sendR, sr, REVERB_STEREO_SPREAD);
  const master = masterChain(L, R, sr, opts.stem !== undefined
    ? { wetL, wetR, comp: false, softClip: false }
    : { wetL, wetR, limiter: true, ...opts.master });
  return { left: L, right: R, sr, duration: len / sr, rangeSec, master };
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
