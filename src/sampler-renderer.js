// aria — 외부 sampler engine이 만든 dry stereo PCM을 Aria의 트랙·믹스·마스터 단계로 합친다.
// 악기 샘플을 직접 해석하거나 비슷한 악기로 대체하지 않는다.
import path from "node:path";
import {
  SF_PRESETS, SF_DRUM_KITS, isSfPreset, isSfDrumKit, drumPieces
} from "./presets.js";
import {
  noteToMidi, beatsPerBar, noteStartBeat, totalBars, tempoSegments, beatToSec, secToBeat,
  notePlaybackEndBeat, effectiveArticulation
} from "./song.js";
import { fontStatus, requiredFontPath, requiredFontName } from "./sf2.js";
import { openSpessaSession } from "./spessa-engine.js";
import {
  assertSfizzCoverage, openSfizzSession, resolveSfzPath, SFIZZ_ENGINE_ID
} from "./sfizz-engine.js";
import { masterChain } from "./master.js";
import { eq3, eqActive } from "./eq.js";
import { rampEnvelope, reverbProcess } from "./renderer.js";

const DEFAULT_VEL_RANGE = 0.65;
const DEFAULT_DRUM_VEL_RANGE = 0.6;
const REVERB_STEREO_SPREAD = 23;

function failUnsupported(track, controls) {
  const names = controls.map(name => {
    if (name === "attack") return "어택 (Attack) — 소리가 시작되는 시간";
    if (name === "release") return "릴리스 (Release) — 음을 놓은 뒤의 여운";
    if (name === "vibrato") return "비브라토 (Vibrato) — 음높이를 주기적으로 떠는 연주";
    return "앙상블 (Ensemble) — 독주 샘플을 여러 번 겹치는 근사 합주";
  });
  const error = new Error(
    `트랙 "${track.name}"의 ${names.join(", ")} 설정은 새 샘플 엔진에서 자동으로 흉내 내지 않습니다 — 원본 음원의 실제 주법으로 다시 선택해 주세요`
  );
  error.code = "CAPABILITY_UNSUPPORTED";
  error.controls = controls;
  throw error;
}

function validateTrackControls(track) {
  const unsupported = [];
  if (track.attack !== undefined) unsupported.push("attack");
  if (track.release !== undefined) unsupported.push("release");
  if ((track.vibrato ?? 0) !== 0) unsupported.push("vibrato");
  if ((track.ensemble ?? 1) !== 1) unsupported.push("ensemble");
  if (unsupported.length) failUnsupported(track, unsupported);
}

function velocityForEngine(noteVelocity, range) {
  // 0이면 모든 음을 중간 세기로, 1이면 악보의 원래 velocity를 그대로 엔진에 보낸다.
  // 후단에서 velocity를 다시 곱하지 않으므로 SoundFont의 원래 layer·modulator를 이중 적용하지 않는다.
  return Math.max(1, Math.min(127, Math.round(64 + (noteVelocity - 64) * range)));
}

function stereoBalance(left, right, pan) {
  // 이미 stereo인 음원을 mono equal-power pan에 다시 넣지 않는다. 가운데는 L/R을 그대로
  // 보존하고, 한쪽으로 움직일 때 반대 채널만 부드럽게 줄이는 balance 방식이다.
  const leftGain = pan > 0 ? Math.cos(pan * Math.PI / 2) : 1;
  const rightGain = pan < 0 ? Math.cos(-pan * Math.PI / 2) : 1;
  if (leftGain !== 1) for (let i = 0; i < left.length; i++) left[i] *= leftGain;
  if (rightGain !== 1) for (let i = 0; i < right.length; i++) right[i] *= rightGain;
}

function constantRegionGain(track, bar) {
  let gain = 1;
  for (const region of track.gains ?? []) {
    if (region.to_db === undefined && bar >= region.from && bar <= region.to)
      gain *= Math.pow(10, region.db / 20);
  }
  return gain;
}

function injectedPreset(options, id) {
  const registry = options?.samplerPresets;
  if (registry instanceof Map) return registry.get(id);
  if (registry && typeof registry === "object" && !Array.isArray(registry) && Object.hasOwn(registry, id))
    return registry[id];
  return undefined;
}

function presetSpec(options, id) {
  const injected = injectedPreset(options, id);
  const melodic = isSfPreset(id), drum = isSfDrumKit(id);
  if (injected !== undefined && (melodic || drum))
    throw new Error(`프리셋 ${id}가 기본 registry와 samplerPresets에 중복 등록되었습니다`);
  if (injected !== undefined) return { preset: injected, drum: injected?.drum === true, injected: true };
  if (drum) return { preset: SF_DRUM_KITS[id], drum: true, injected: false };
  if (melodic) return { preset: SF_PRESETS[id], drum: false, injected: false };
  return null;
}

function samplerPerformanceNote(track, registered, note, velocityRange) {
  const { preset, drum: sfDrum } = registered;
  const pieces = registered.injected ? preset.pieces : drumPieces(track.preset);
  const key = sfDrum ? pieces?.[note.pitch] : noteToMidi(note.pitch);
  if (key === undefined || key === null)
    throw new Error(`트랙 "${track.name}"의 음 ${note.pitch}을 ${track.preset}에서 찾을 수 없습니다`);
  return {
    key,
    velocity: velocityForEngine(note.vel, velocityRange),
    bend: sfDrum ? 0 : (note.bend ?? 0),
    // 구간 주법은 음이 시작되는 마디에서 결정한다. 경계를 가로지르는 긴 음을
    // 중간에 다른 샘플로 갈아 끼우지 않고 note-off까지 같은 주법으로 유지한다.
    articulation: preset.engine === SFIZZ_ENGINE_ID ? effectiveArticulation(track, note.bar) : undefined,
    gain: (preset.gain ?? 1) * 0.9 * constantRegionGain(track, note.bar),
    // 같은 MIDI key라도 하이햇 개방도처럼 CC 상태가 다른 피스가 있다.
    // 피스 ID에 연결된 원래 control을 노트와 함께 sampler로 전달한다.
    controls: sfDrum ? (preset.pieceControls?.[note.pitch] ?? []) : []
  };
}

function coverageErrorMessage(track, preset, sourceNote, performance, articulationId, engineError) {
  const selectedId = articulationId ?? preset.defaultArticulation;
  const definition = selectedId === undefined || selectedId === null
    ? null : preset.articulations?.[selectedId];
  const articulation = definition?.label ?? selectedId ?? "Preset Default (프리셋 기본 주법)";
  const keyswitch = definition?.keyswitch;
  const keyswitchKey = typeof keyswitch === "number" ? keyswitch : keyswitch?.key;
  const velocity = performance.velocity === sourceNote.vel
    ? String(performance.velocity)
    : `${performance.velocity} (악보 값 ${sourceNote.vel}에 Velocity Range를 적용한 실제 입력)`;
  const pitch = typeof sourceNote.pitch === "string" ? sourceNote.pitch : String(sourceNote.pitch);
  return `트랙 "${track.name}"의 ${sourceNote.bar}마디 ${sourceNote.beat}박 `
    + `Pitch (피치, 음높이) ${pitch} (MIDI ${performance.key}), `
    + `Velocity (벨로시티, 음을 세게·여리게 내는 값) ${velocity}는 `
    + `Articulation (아티큘레이션, 실제 녹음 연주법) ${articulation}`
    + (Number.isInteger(keyswitchKey)
      ? `의 Keyswitch (키스위치, 건반으로 주법을 바꾸는 신호) MIDI ${keyswitchKey}` : "")
    + ` 상태에서 SFZ ${path.basename(engineError.details?.sfz ?? preset.sfz)}의 `
    + "Attack Region (어택 리전, 음을 누르는 순간 실제 소리가 시작되는 샘플 구간)이 없습니다"
    + " — 이 편집을 적용하면 해당 음이 무음이 되므로 저장하지 않았습니다. "
    + "음역 안의 Pitch로 옮기거나 이 Pitch·Velocity를 실제로 녹음한 Instrument (인스트루먼트, 악기 음원) 또는 Articulation을 선택하세요";
}

// 곡 편집 preflight: 오디오를 렌더하지 않고 실제 render plan과 같은 pitch·velocity·
// Articulation/Keyswitch/CC 조합이 SFZ attack sample에 닿는지 검사한다.
export function assertSfizzSongCoverage(song, options = {}) {
  let checkedTracks = 0, checkedNotes = 0;
  for (const track of song.tracks) {
    const registered = presetSpec(options, track.preset);
    if (!registered || registered.preset?.engine !== SFIZZ_ENGINE_ID || !track.notes.length) continue;
    // renderRange의 planTrack과 같은 방어선을 공유한다. 현재 song validation은 이
    // legacy 필드를 보존하지 않지만, 이전 in-memory 객체나 내부 호출도 preflight만
    // 통과한 뒤 실제 render에서 뒤늦게 실패해서는 안 된다.
    validateTrackControls(track);
    const { preset, drum: sfDrum } = registered;
    const velocityRange = track.velRange ?? preset.velRange ??
      (sfDrum ? DEFAULT_DRUM_VEL_RANGE : DEFAULT_VEL_RANGE);
    const groups = new Map();
    for (const note of track.notes) {
      const performance = samplerPerformanceNote(track, registered, note, velocityRange);
      const id = performance.articulation;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ sourceNote: note, performance });
    }
    const entries = [...groups.entries()];
    const layers = entries.map(([articulation, notes]) => ({
      articulation,
      notes: notes.map(({ performance }) => ({
        key: performance.key,
        velocity: performance.velocity,
        controls: performance.controls
      }))
    }));
    try {
      assertSfizzCoverage(preset, layers, { packRoots: options.packRoots });
    } catch (error) {
      if (error?.details?.reason !== "attack-region-missing") throw error;
      const layer = entries[error.details.layerIndex];
      const source = layer?.[1]?.[error.details.noteIndex];
      if (!source) throw error;
      error.message = coverageErrorMessage(
        track, preset, source.sourceNote, source.performance, layer[0], error
      );
      error.attackCoverageMismatch = true;
      error.track = track.name;
      error.bar = source.sourceNote.bar;
      error.beat = source.sourceNote.beat;
      error.pitch = source.sourceNote.pitch;
      error.midi = source.performance.key;
      error.velocity = source.performance.velocity;
      error.articulation = layer[0] ?? preset.defaultArticulation ?? null;
      throw error;
    }
    checkedTracks++;
    checkedNotes += track.notes.length;
  }
  return { checkedTracks, checkedNotes };
}

const CLIP_TIME_EPSILON = 1e-9;

function fixedClipEndBeat(song, track, note, segs, preset) {
  let end = notePlaybackEndBeat(song, track, note, segs);
  // samplerPresets로 주입한 통합-test fixture는 전역 registry에 없으므로 song helper가
  // 원본 초 길이를 알 수 없다. 공개 renderer의 같은 계약을 시험할 수 있게 주입 spec의
  // durationSec도 같은 초→beat 변환으로 합친다.
  if (Number.isFinite(preset?.durationSec) && preset.durationSec > 0) {
    const start = noteStartBeat(song, note);
    end = Math.max(end, secToBeat(segs, beatToSec(segs, start) + preset.durationSec));
  }
  return end;
}

function rejectRangeStartingInsideFixedClip(song, tracks, fromBar, bpb, segs, options) {
  const rangeStart = (fromBar - 1) * bpb;
  if (rangeStart <= 0) return;
  for (const track of tracks) {
    const registered = presetSpec(options, track.preset);
    if (registered?.preset?.kind !== "clip") continue;
    for (const note of track.notes) {
      const start = noteStartBeat(song, note);
      const end = fixedClipEndBeat(song, track, note, segs, registered.preset);
      if (start >= rangeStart - CLIP_TIME_EPSILON || end <= rangeStart + CLIP_TIME_EPSILON) continue;
      const error = new Error(
        `트랙 "${track.name}"의 Recorded Clip이 ${note.bar}마디에서 시작해 ${fromBar}마디 재생 시작점까지 이어집니다`
        + ` — 현재 고정 clip은 중간 offset 재생을 지원하지 않습니다. 무음으로 넘기지 않았습니다; from_bar를 ${note.bar} 이하로 지정하거나 clip 전체를 move_note로 옮기세요`
      );
      error.code = "CAPABILITY_UNSUPPORTED";
      error.track = track.name;
      error.clipTriggerBar = note.bar;
      error.requestedFromBar = fromBar;
      throw error;
    }
  }
}

function planTrack(song, track, fromBar, toBar, segs, startSec, len, sr, options) {
  const registered = presetSpec(options, track.preset);
  if (!registered)
    throw new Error(`지원하지 않는 프리셋 ${track.preset} — 등록되지 않은 sampler 악기를 자동 대체하지 않았습니다`);
  validateTrackControls(track);

  const { preset, drum: sfDrum } = registered;
  if (!preset || typeof preset !== "object" || Array.isArray(preset))
    throw new Error(`프리셋 ${track.preset}의 sampler spec이 올바르지 않습니다`);
  const engine = preset.engine ?? "spessa-sf2";
  let assetPath, assetName, resolvedAsset, enginePreset;
  if (engine === SFIZZ_ENGINE_ID) {
    resolvedAsset = resolveSfzPath(preset, { packRoots: options?.packRoots });
    assetPath = resolvedAsset.file;
    assetName = resolvedAsset.pack
      ? `${resolvedAsset.pack}/${path.basename(resolvedAsset.file)}`
      : path.basename(resolvedAsset.file);
    enginePreset = preset;
  } else if (engine === "spessa-sf2") {
    const status = fontStatus(preset);
    if (!status.available)
      throw new Error(`트랙 "${track.name}"의 음원 ${requiredFontName(preset)}을 사용할 수 없습니다: ${status.reason} — 다른 음원으로 자동 대체하지 않았습니다`);
    assetPath = requiredFontPath(preset);
    assetName = requiredFontName(preset);
    enginePreset = {
      bank: preset.bank ?? 0,
      program: preset.program ?? preset.gm,
      drum: sfDrum
    };
  } else {
    const error = new Error(`프리셋 ${track.preset}의 sampler engine ${JSON.stringify(engine)}을 지원하지 않습니다`);
    error.code = "CAPABILITY_UNSUPPORTED";
    throw error;
  }

  const velocityRange = track.velRange ?? preset.velRange ??
    (sfDrum ? DEFAULT_DRUM_VEL_RANGE : DEFAULT_VEL_RANGE);
  const notes = [];
  for (const note of track.notes) {
    if (note.bar < fromBar || note.bar > toBar) continue;
    const beat = noteStartBeat(song, note);
    const start = Math.round((beatToSec(segs, beat) - startSec) * sr);
    if (start < 0 || start >= len) continue;
    const gateSec = beatToSec(segs, beat + note.dur) - beatToSec(segs, beat);
    const end = Math.min(len, Math.max(start + 1, Math.round(start + gateSec * sr)));
    const performance = samplerPerformanceNote(track, registered, note, velocityRange);
    notes.push({
      ...performance,
      startSample: start,
      endSample: end,
    });
  }
  return {
    track, preset, sfDrum, notes, engine, assetPath, assetName, resolvedAsset, enginePreset
  };
}

// sfizz의 한 renderTrack 호출은 시작 시점에 키스위치/CC 하나를 설정한다. 한 트랙에
// 여러 구간 주법이 있으면 주법별로 독립 렌더한 dry PCM을 먼저 합친다. 그러면 서로
// 다른 주법의 긴 음이 겹쳐도 채널 전역 키스위치가 앞 음을 바꾸지 않으며, 트랙의
// pan/EQ/reverb/volume은 합친 뒤 정확히 한 번만 적용된다.
function renderPlan(session, plan, len) {
  if (plan.engine !== SFIZZ_ENGINE_ID) {
    return session.renderTrack({
      preset: plan.enginePreset,
      track: {},
      notes: plan.notes,
      length: len
    });
  }

  const groups = new Map();
  for (const note of plan.notes) {
    const id = note.articulation;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(note);
  }
  if (groups.size === 1) {
    const [articulation, notes] = groups.entries().next().value;
    return session.renderTrack({
      preset: plan.enginePreset,
      track: { articulation },
      notes,
      length: len
    });
  }

  const left = new Float32Array(len), right = new Float32Array(len);
  const layers = [], layerDiagnostics = [];
  for (const [articulation, notes] of groups) {
    const rendered = session.renderTrack({
      preset: plan.enginePreset,
      track: { articulation },
      notes,
      length: len
    });
    for (let i = 0; i < len; i++) {
      left[i] += rendered.left[i];
      right[i] += rendered.right[i];
    }
    layers.push({
      id: rendered.diagnostics.articulation ?? articulation ?? null,
      notes: notes.length,
      invocations: rendered.diagnostics.invocations ?? 1,
      ...(rendered.diagnostics.gain !== undefined ? { gain: rendered.diagnostics.gain } : {})
    });
    layerDiagnostics.push(rendered.diagnostics);
  }
  // 기존 단일 주법 진단 필드를 잃지 않도록 multi-render의 처리량은 합하고, 실제로
  // 섞인 최종 dry PCM의 peak/nonzero/stereo 차이는 다시 측정한다.
  const sum = key => layerDiagnostics.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  let peak = 0, nonzeroSamples = 0, stereoDifference = 0;
  for (let i = 0; i < len; i++) {
    const l = left[i], r = right[i];
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    if (Math.abs(l) > 1 / 32768 || Math.abs(r) > 1 / 32768) nonzeroSamples++;
    stereoDifference += Math.abs(l - r);
  }
  const first = layerDiagnostics[0];
  const gains = [...new Set(layerDiagnostics.map(item => item.gain).filter(value => value !== undefined))];
  return {
    left, right,
    diagnostics: {
      engine: SFIZZ_ENGINE_ID,
      sfz: first.sfz,
      ...(first.pack !== undefined ? { pack: first.pack } : {}),
      notes: sum("notes"),
      articulations: layers,
      invocations: sum("invocations"),
      channels: sum("channels"),
      bendNotes: sum("bendNotes"),
      controlledNotes: sum("controlledNotes"),
      bendEvents: sum("bendEvents"),
      pitchRangeSemitones: first.pitchRangeSemitones,
      sourceFrames: sum("sourceFrames"),
      trimmedFrames: sum("trimmedFrames"),
      paddedFrames: sum("paddedFrames"),
      sourceEncoding: first.sourceEncoding,
      ...(gains.length === 1 ? { gain: gains[0] } : gains.length ? { gains } : {}),
      peak,
      nonzeroSamples,
      stereoMeanDifference: len ? stereoDifference / len : 0
    }
  };
}

function mixTrack(plan, dry, song, segs, startSec, len, sr, opts, L, R, sendL, sendR) {
  const { track, preset, sfDrum } = plan;
  const revAmt = track.reverb ?? (sfDrum ? 0.12 : (preset.reverb ?? 0.2));
  const eq = { low: track.eqLow, mid: track.eqMid, high: track.eqHigh };
  const eqOn = eqActive(eq);
  const tL = dry.left, tR = dry.right;
  stereoBalance(tL, tR, track.pan);

  const ramps = (track.gains ?? []).filter(g => g.to_db !== undefined);
  const ramp = ramps.length ? rampEnvelope(ramps, song, segs, startSec, len, sr) : null;
  const volume = opts.stem !== undefined ? 1 : track.volume;
  for (let i = 0; i < len; i++) {
    const gain = volume * (ramp ? ramp[i] : 1);
    tL[i] *= gain;
    tR[i] *= gain;
  }

  if (eqOn) { eq3(tL, sr, eq); eq3(tR, sr, eq); }
  for (let i = 0; i < len; i++) {
    L[i] += tL[i];
    R[i] += tR[i];
    sendL[i] += tL[i] * revAmt;
    sendR[i] += tR[i] * revAmt;
  }
}

function automaticTailSeconds(song, tracks, fromBar, toBar, segs, startSec, rangeSec, options) {
  let requiredEnd = rangeSec;
  for (const track of tracks) {
    const registered = presetSpec(options, track.preset);
    if (!registered?.preset) continue;
    const { preset, drum } = registered;
    const release = Number.isFinite(preset.release) && preset.release >= 0 ? preset.release : 0.3;
    const recordedTail = Number.isFinite(preset.tailHintSec) && preset.tailHintSec >= 0
      ? preset.tailHintSec : 0.5;
    for (const note of track.notes) {
      if (note.bar < fromBar || note.bar > toBar) continue;
      const beat = noteStartBeat(song, note);
      const noteStart = beatToSec(segs, beat) - startSec;
      const gate = beatToSec(segs, beat + note.dur) - beatToSec(segs, beat);
      const exactPieceDuration = Number.isFinite(preset.pieceDurationsSec?.[note.pitch]) &&
          preset.pieceDurationsSec[note.pitch] > 0
        ? preset.pieceDurationsSec[note.pitch] : null;
      // Recorded Clip은 단일 녹음 길이를 사용한다. 드럼/타악기 킷은 실제로
      // 누른 피스의 최장 RR/velocity sample 길이를 사용해, 긴 심벌 하나가
      // 모든 킥·스네어의 출력 길이를 늘리지 않게 한다.
      let recordedDuration = exactPieceDuration;
      if (recordedDuration === null && preset.kind === "clip" &&
          Number.isFinite(preset.durationSec) && preset.durationSec > 0)
        recordedDuration = preset.durationSec;
      // 오래된 manifest에 per-piece 측정값이 없으면 잘라내기보다 킷 전체
      // 최장 길이를 택한다. 새 manifest는 모든 피스에 측정값을 기록한다.
      if (recordedDuration === null && drum && preset.kind !== "clip") {
        const fallback = Number.isFinite(preset.durationSec) && preset.durationSec > 0
          ? preset.durationSec : preset.maxSampleDurationSec;
        if (Number.isFinite(fallback) && fallback > 0) recordedDuration = fallback;
      }
      // Recorded Clip/개별 one-shot은 악보의 짧은 trigger 길이와 관계없이 원본을
      // 끝까지 재생한다. 일반 악기는 noteOff 이후의 실제 release만 더한다.
      const noteEnd = recordedDuration === null
        ? noteStart + gate + release
        : noteStart + recordedDuration + recordedTail;
      requiredEnd = Math.max(requiredEnd, noteEnd);
    }
  }
  // 기존 공간계 꼬리 2.2초는 유지하되, 긴 원음이 구간 안에서 이미 끝났다면
  // 그 전체 길이를 구간 뒤에 또 붙이지 않는다.
  return Math.max(2.2, requiredEnd - rangeSec);
}

// 공개 재생·WAV·스템 경로가 쓰는 기본 renderer. 같은 engine asset을 쓰는 트랙들을
// 한 session에서 처리하고 즉시 닫아, 큰 sample pack을 동시에 붙잡지 않는다.
export function renderRange(song, fromBar = 1, toBar = totalBars(song), opts = {}) {
  const sr = opts.sampleRate ?? 44100;
  if (!Number.isInteger(fromBar) || fromBar < 1 || !Number.isInteger(toBar) || toBar < 1)
    throw new Error(`렌더 구간의 fromBar/toBar는 1 이상의 정수여야 합니다 (받은 값: ${JSON.stringify(fromBar)}~${JSON.stringify(toBar)})`);
  if (fromBar > toBar)
    throw new Error(`렌더 구간의 fromBar는 toBar보다 클 수 없습니다 (${fromBar}~${toBar}마디)`);
  if (!Number.isInteger(sr) || sr < 8000 || sr > 192000)
    throw new Error(`렌더 sampleRate는 8000~192000Hz 정수여야 합니다 (받은 값: ${JSON.stringify(sr)})`);
  if (opts.tail !== undefined && (typeof opts.tail !== "number" || !Number.isFinite(opts.tail) || opts.tail < 0))
    throw new Error(`렌더 tail은 0 이상의 유한한 초여야 합니다 (받은 값: ${JSON.stringify(opts.tail)})`);

  const soloOn = song.tracks.some(track => track.solo);
  const audible = track => soloOn ? !!track.solo : !track.mute;
  const selected = song.tracks.filter(track =>
    opts.stem !== undefined ? track.name === opts.stem : audible(track));
  const bpb = beatsPerBar(song);
  const segs = tempoSegments(song);
  rejectRangeStartingInsideFixedClip(song, selected, fromBar, bpb, segs, opts);
  const selectedInRange = selected.filter(track =>
    track.notes.some(note => note.bar >= fromBar && note.bar <= toBar));
  const startSec = beatToSec(segs, (fromBar - 1) * bpb);
  const rangeSec = beatToSec(segs, toBar * bpb) - startSec;
  // 음소거·solo 제외 트랙이나 다른 stem은 현재 출력 길이를 늘리지 않는다.
  // 원음 길이는 마지막 trigger 위치를 반영해 필요한 만큼만 구간 뒤에 남긴다.
  const tail = opts.tail ?? automaticTailSeconds(
    song, selectedInRange, fromBar, toBar, segs, startSec, rangeSec, opts);
  const len = Math.max(1, Math.ceil((rangeSec + tail) * sr));
  const L = new Float32Array(len), R = new Float32Array(len);
  const sendL = new Float32Array(len), sendR = new Float32Array(len);
  const diagnostics = [];

  const plans = selectedInRange
    .map(track => planTrack(song, track, fromBar, toBar, segs, startSec, len, sr, opts))
    .filter(plan => plan.notes.length);
  const groups = new Map();
  for (const plan of plans) {
    const key = `${plan.engine}\0${plan.assetPath}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(plan);
  }

  for (const group of groups.values()) {
    const first = group[0];
    const usages = group.map(plan => ({
      preset: plan.enginePreset,
      notes: plan.notes.map(note => ({ key: note.key, velocity: note.velocity }))
    }));
    const session = first.engine === SFIZZ_ENGINE_ID
      ? openSfizzSession(first.assetPath, sr, {
          preset: first.enginePreset,
          packRoots: opts.packRoots
        })
      : openSpessaSession(first.assetPath, sr, usages);
    try {
      for (const plan of group) {
        let dry;
        try {
          dry = renderPlan(session, plan, len);
        } catch (error) {
          error.message = `트랙 "${plan.track.name}": ${error.message}`;
          throw error;
        }
        mixTrack(plan, dry, song, segs, startSec, len, sr, opts, L, R, sendL, sendR);
        diagnostics.push({
          track: plan.track.name,
          asset: plan.assetName,
          ...(plan.engine === "spessa-sf2" ? { font: plan.assetName } : {}),
          ...dry.diagnostics
        });
      }
    } finally {
      session.close();
    }
  }

  const wetL = reverbProcess(sendL, sr, 0);
  const wetR = reverbProcess(sendR, sr, REVERB_STEREO_SPREAD);
  const master = masterChain(L, R, sr, opts.stem !== undefined
    ? { wetL, wetR, comp: false, softClip: false }
    : { wetL, wetR, limiter: true, ...opts.master });
  return { left: L, right: R, sr, duration: len / sr, rangeSec, master, diagnostics };
}
