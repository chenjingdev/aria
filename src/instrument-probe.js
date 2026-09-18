// A bounded, dry audition. Measurements describe the requested note only.
import { openSfizzSession, resolveSfzPath } from "./sfizz-engine.js";

export function measureNoteResponse(pcm, start, end, sampleRate) {
  const rms = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += (pcm.left[i] ** 2 + pcm.right[i] ** 2) / 2;
    return Math.sqrt(sum / Math.max(1, to - from));
  };
  const db = n => 20 * Math.log10(Math.max(n, 1e-12));
  const gate = rms(start, end);
  return {
    gateRmsDb: db(gate),
    earlyRelativeDb: db(rms(start, Math.min(end, start + Math.round(.06 * sampleRate))) / Math.max(gate, 1e-12)),
    spillRelativeDb: db(rms(end + Math.round(.1 * sampleRate), end + Math.round(.3 * sampleRate)) / Math.max(gate, 1e-12)),
    weakGate: gate < 1e-6
  };
}

export function probeSfizzInstrument(spec, { articulation, pitch, velocity = 80, duration = .25 } = {}) {
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw new Error("probe pitch는 MIDI 0~127 정수여야 합니다");
  if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) throw new Error("probe velocity는 1~127 정수여야 합니다");
  if (!Number.isFinite(duration) || duration < .05 || duration > 2) throw new Error("probe duration은 0.05~2초여야 합니다");
  const sampleRate = 22050, start = Math.round(.2 * sampleRate), end = Math.round((.2 + duration) * sampleRate);
  const session = openSfizzSession(resolveSfzPath(spec).file, sampleRate, { preset: spec });
  try {
    const pcm = session.renderTrack({ preset: spec, track: { articulation: articulation ?? undefined },
      notes: [{ key: pitch, velocity, startSample: start, endSample: end, gain: 1 }], length: end + sampleRate });
    return { pitch, velocity, duration, sampleRate, ...measureNoteResponse(pcm, start, end, sampleRate) };
  } finally { session.close(); }
}
