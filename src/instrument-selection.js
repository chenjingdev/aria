// Read-only instrument selection: actual sample coverage and equivalent voices.
import { SF_PRESETS, SF_DRUM_KITS } from "./presets.js";
import { catalogNodes, canonVariant, resolvePresetAlias } from "./catalog.js";
import { samplerAssetStatus } from "./sampler-assets.js";
import { inspectSfizzPreset } from "./sfizz-engine.js";
import { probeSfizzInstrument } from "./instrument-probe.js";
import { effectiveArticulation, findTrack, noteToMidi, totalBars } from "./song.js";

const registry = id => SF_PRESETS[id] ?? SF_DRUM_KITS[id];
const available = id => samplerAssetStatus(registry(id), { shallow: true }).available;
const midiName = n => `${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][n % 12]}${Math.floor(n / 12) - 1}`;
export const rangesText = ranges => ranges.map(([a, b]) => a === b ? midiName(a) : `${midiName(a)}–${midiName(b)}`).join(", ") || "없음";

function variant(spec, voice) {
  return canonVariant(spec.articulations?.[voice.id]?.originalTerm ?? spec.articulation ?? "sustain");
}
function variantFamily(value) {
  const v = canonVariant(value);
  if (["sustain", "vibrato", "sustain-vibrato", "sustain-non-vibrato"].includes(v)) return "sustain";
  if (["staccato", "spiccato"].includes(v)) return "short";
  return v;
}

export function inspectInstrument(ref, options = {}) {
  const id = registry(ref) ? ref : resolvePresetAlias(ref, available).id;
  const spec = registry(id);
  const status = samplerAssetStatus(spec, { shallow: true });
  if (!status.available) throw new Error(`음원 ${id}: ${status.reason}`);
  if (spec.engine !== "sfizz") return {
    preset: id, source: spec.source, name: spec.name, engine: status.engine,
    coverageVerified: false,
    note: "이 SoundFont의 선택 단계 음역 정보는 아직 제공하지 않습니다. 실제 렌더에서 검사합니다."
  };
  const profile = inspectSfizzPreset(spec, options);
  return {
    preset: id, source: spec.source, name: spec.name, engine: profile.engine,
    coverageVerified: true,
    articulations: profile.articulations.map(voice => ({
      ...voice, variant: variant(spec, voice),
      range: rangesText(voice.keyRanges),
      rangeAtVelocities40_80_110: rangesText(voice.safeRanges)
    }))
  };
}

export function instrumentProfileText(ref, { pitch, velocity, duration } = {}) {
  if (!pitch && (velocity !== undefined || duration !== undefined)) throw new Error("연주 측정에는 pitch를 함께 지정하세요");
  const profile = inspectInstrument(ref);
  if (!profile.coverageVerified) return `${profile.preset} — ${profile.name}\n${profile.note}`;
  let result = `${profile.preset} — ${profile.name}\n` + profile.articulations.map(v =>
    `  ${v.id ?? "default"}: ${v.variant} · velocity 64 음역 ${v.range}`
    + ` · velocity 40/80/110 공통 ${v.rangeAtVelocities40_80_110}`
    + ` · velocity 구간 ${v.velocityBands.join(",")}`
    + (v.attackSeconds.length ? ` · 정의된 attack ${v.attackSeconds.join("/")}초` : "")
    + (v.releaseSeconds.length ? ` · 정의된 release ${v.releaseSeconds.join("/")}초` : "")
    + (v.loopModes.length ? ` · loop ${v.loopModes.join("/")}` : "")
  ).join("\n") + "\n음역은 실제 샘플 매핑입니다. attack/release는 SFZ 설정이며 녹음 자체의 발음 속도나 음질 점수가 아닙니다.";
  if (pitch) {
    const key = noteToMidi(pitch);
    const measurements = profile.articulations.map(v => {
      try { return { articulation: v.id, variant: v.variant, ...probeSfizzInstrument(registry(profile.preset), { articulation: v.id, pitch: key, velocity, duration }) }; }
      catch (e) { return { articulation: v.id, error: e.message }; }
    });
    result += `\n\n건조한 단음 실제 렌더 측정(스피커 재생 없음): ${JSON.stringify(measurements)}\n`
      + "gateRmsDb는 누르는 동안의 RMS dBFS, earlyRelativeDb는 첫 60ms, spillRelativeDb는 음을 뗀 뒤 100~300ms의 상대 RMS입니다. 녹음의 발음·여운을 이 음높이·세기·길이에서 비교하는 값이며 음질 점수가 아닙니다.";
  }
  return result;
}

// The written pitches, velocities and articulation are the query. No composition
// is rewritten and no aesthetic winner is inferred from a library name.
export function findPresetCandidates(song, { track: name, from_bar = 1, to_bar = totalBars(song), articulation, limit = 5 } = {}, options = {}) {
  if (!Number.isInteger(from_bar) || !Number.isInteger(to_bar) || from_bar < 1 || to_bar < from_bar || to_bar > totalBars(song))
    throw new Error("곡 안의 유효한 from_bar~to_bar 구간을 지정하세요");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit은 1~20 정수여야 합니다");
  const track = findTrack(song, name);
  const nodes = options.nodes ?? catalogNodes();
  const inspect = options.inspect ?? inspectInstrument;
  const isAvailable = options.isAvailable ?? available;
  const current = nodes.find(n => n.id === track.preset);
  if (!current || current.kind !== "instrument") throw new Error("find_presets는 선율 악기 트랙을 대상으로 합니다. 타악은 inspect_instrument로 확인하세요");
  const notes = track.notes.filter(n => n.bar >= from_bar && n.bar <= to_bar);
  if (!notes.length) throw new Error("이 구간에는 비교할 음표가 없습니다");
  const performance = notes.map(n => ({
    key: noteToMidi(n.pitch), velocity: Math.max(1, Math.min(127, Math.round(64 + ((n.vel ?? 96) - 64) * (track.velRange ?? current.spec.velRange ?? 0.65))))
  }));
  const variants = [...new Set(notes.map(n => {
    const id = effectiveArticulation(track, n.bar) ?? current.spec.defaultArticulation;
    return canonVariant(current.spec.articulations?.[id]?.originalTerm ?? current.spec.articulation ?? "sustain");
  }))];
  if (!articulation && variants.length !== 1) throw new Error("구간에 여러 주법이 있습니다. 구간을 좁히거나 찾을 articulation을 지정하세요");
  const requested = canonVariant(articulation ?? variants[0]);
  const candidates = [], unavailable = [], unverified = [];
  for (const node of nodes.filter(n => n.instrument === current.instrument && n.unit === current.unit && n.kind === "instrument")) {
    if (!isAvailable(node.id)) { unavailable.push(node.id); continue; }
    let profile;
    try { profile = inspect(node.id); }
    catch (e) { unavailable.push({ preset: node.id, reason: e.message }); continue; }
    if (!profile.coverageVerified) { unverified.push(node.id); continue; }
    for (const voice of profile.articulations) {
      if (variantFamily(voice.variant) !== variantFamily(requested)) continue;
      const missing = performance.filter(n => !voice.coverage.some(r => n.key >= r.keys[0] && n.key <= r.keys[1]
        && n.velocity >= r.velocity[0] && n.velocity <= r.velocity[1]));
      candidates.push({ preset: node.id, articulation: voice.id, variant: voice.variant, source: node.source,
        range: voice.range, soundKey: voice.soundKey, matchedNotes: notes.length - missing.length,
        missingNotes: missing.length, missingPitches: [...new Set(missing.map(n => midiName(n.key)))],
        exactArticulation: voice.variant === requested, sourceRank: node.sourceRank,
        equivalents: [] });
    }
  }
  candidates.sort((a, b) => a.missingNotes - b.missingNotes || Number(b.exactArticulation) - Number(a.exactArticulation)
    || Number(a.articulation !== null) - Number(b.articulation !== null) || a.sourceRank - b.sourceRank || a.preset.localeCompare(b.preset));
  const groups = new Map();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.soundKey);
    if (existing) existing.equivalents.push({ preset: candidate.preset, articulation: candidate.articulation });
    else groups.set(candidate.soundKey, candidate);
  }
  const unique = [...groups.values()];
  const compatible = unique.filter(c => c.missingNotes === 0);
  return { track: name, fromBar: from_bar, toBar: to_bar, requestedArticulation: requested, notes: notes.length,
    rawCandidates: candidates.length, uniqueSounds: unique.length, compatibleSounds: compatible.length,
    candidates: compatible.slice(0, limit),
    rejected: unique.filter(c => c.missingNotes > 0).map(({ preset, articulation, missingNotes, missingPitches }) => ({ preset, articulation, missingNotes, missingPitches })),
    unverified, unavailable,
    note: "현재 음표·실제 velocity의 샘플 존재를 검사했습니다. 같은 샘플·재생 정의는 한 후보로 묶었습니다. 순서는 주법 일치와 기본 정렬이며 음질 순위가 아닙니다."
  };
}
