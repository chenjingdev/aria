// aria — SpessaSynth 기반 비압축 SF2/DLS 오프라인 샘플러 어댑터.
//
// 이 모듈은 SoundFont를 한 세션/한 processor가 단독 소유한다. 같은 BasicSoundBank를
// 여러 processor에 넣으면 한 processor의 destroy가 다른 processor의 bank까지 비워 버릴
// 수 있으므로, parsed bank를 전역 cache로 공유하지 않는다.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  KeyModifier,
  MIDIControllers,
  SoundBankLoader,
  SpessaSynthProcessor
} from "spessasynth_core";

const require = createRequire(import.meta.url);
const { version: SPESSA_VERSION } = require("spessasynth_core/package.json");

export const SPESSA_ENGINE_ID = "spessa-sf2";
export const SPESSA_QUANTUM = 128;
const PITCH_RANGE_SEMITONES = 12;
const MAX_GAIN = 16;

export class SpessaEngineError extends Error {
  constructor(code, message, details = undefined, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = "SpessaEngineError";
    this.code = code;
    this.engine = SPESSA_ENGINE_ID;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details, cause) => {
  throw new SpessaEngineError(code, message, details, cause);
};

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    fail("INVALID_RENDER_REQUEST", `${name}은(는) ${min}~${max} 정수여야 합니다`, { name, value, min, max });
  return value;
}

function finite(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail("INVALID_RENDER_REQUEST", `${name}은(는) ${min}~${max} 사이 숫자여야 합니다`, { name, value, min, max });
  return value;
}

function normalizePreset(preset) {
  if (!preset || typeof preset !== "object" || Array.isArray(preset))
    fail("INVALID_PRESET", "preset은 SoundFont bank/program 정보가 든 객체여야 합니다", { preset });

  const program = preset.program ?? preset.gm;
  integer(program, "preset.program", 0, 127);
  // Aria는 전통적인 SF2 drum bank를 논리값 128로 기록한다. SpessaSynth는 같은
  // 정보를 GM/GS drum flag 또는 XG/GM2 bank 120/127로 정규화하므로, drum은
  // manager의 raw bankMSB와 128을 직접 비교하지 않고 isDrum으로 찾는다.
  const drum = preset.drum === true || preset.isDrum === true || preset.bank === 128;
  const hasExplicitEngineBank = preset.bankMSB !== undefined || preset.bankLSB !== undefined;
  const bankMSB = hasExplicitEngineBank
    ? integer(preset.bankMSB ?? 0, "preset.bankMSB", 0, 127)
    : drum ? null : integer(preset.bank ?? 0, "preset.bank", 0, 127);
  const bankLSB = hasExplicitEngineBank
    ? integer(preset.bankLSB ?? 0, "preset.bankLSB", 0, 127)
    : drum ? null : 0;

  return { program, drum, bankMSB, bankLSB, hasExplicitEngineBank };
}

function presetKey(request) {
  return `${request.drum ? "D" : "M"}:${request.bankLSB ?? "*"}:${request.bankMSB ?? "*"}:${request.program}`;
}

function exactPreset(bank, requested, fontPath) {
  let matches = bank.presets.filter(p => p.program === requested.program && p.isDrum === requested.drum);
  if (requested.drum && !requested.hasExplicitEngineBank) {
    // 같은 SF2 drum bank가 Spessa 내부에서 GM/GS(bank 0, isGMGSDrum)와
    // XG 호환 복사본(bank 120)으로 동시에 보일 수 있다. Aria의 논리 bank 128은
    // SF2의 표준 percussion bank를 뜻하므로 GM/GS 표식을 exact 기준으로 삼는다.
    // 이것은 유사 kit fallback이 아니라 같은 파일의 명시적 bank 128 표현을 고르는 규칙이다.
    matches = matches.filter(p => p.isGMGSDrum === true);
  } else if (!requested.drum || requested.hasExplicitEngineBank) {
    matches = matches.filter(p => p.bankMSB === requested.bankMSB && p.bankLSB === requested.bankLSB);
  }

  if (matches.length === 0) {
    fail("PRESET_MISSING",
      `음원 ${path.basename(fontPath)}에 요청한 ${requested.drum ? "드럼 " : ""}bank/program이 없습니다 — 다른 프리셋으로 대체하지 않았습니다`,
      { fontPath, requested });
  }
  if (matches.length > 1) {
    fail("PRESET_AMBIGUOUS",
      `음원 ${path.basename(fontPath)}에서 요청한 drum/program이 ${matches.length}개와 겹칩니다 — bankMSB/bankLSB를 명시해 주세요`,
      { fontPath, requested, matches: matches.map(p => ({
        name: p.name, bankMSB: p.bankMSB, bankLSB: p.bankLSB,
        program: p.program, isGMGSDrum: p.isGMGSDrum, isDrum: p.isDrum
      })) });
  }
  return matches[0];
}

function validateUsageNote(note, where) {
  if (!note || typeof note !== "object" || Array.isArray(note))
    fail("INVALID_RENDER_REQUEST", `${where}는 {key, velocity} 객체여야 합니다`, { note });
  return {
    key: integer(note.key, `${where}.key`, 0, 127),
    velocity: integer(note.velocity, `${where}.velocity`, 1, 127)
  };
}

function ensureVoice(preset, note, fontPath) {
  let voices;
  try { voices = preset.getVoiceParameters(note.key, note.velocity); }
  catch (e) {
    fail("ASSET_CORRUPT",
      `음원 ${path.basename(fontPath)}의 샘플을 준비하지 못했습니다: ${e.message}`,
      { fontPath, preset: preset.name, key: note.key, velocity: note.velocity }, e);
  }
  if (!voices?.length) {
    fail("SAMPLE_MISSING",
      `음원 ${path.basename(fontPath)}의 "${preset.name}"에는 MIDI ${note.key}, velocity ${note.velocity} 샘플이 없습니다 — 무음으로 넘기지 않았습니다`,
      { fontPath, preset: preset.name, key: note.key, velocity: note.velocity });
  }
}

function ensureDeclaredUsage(declarations, preset, note, fontPath) {
  if (declarations === null) return;
  const velocities = declarations.get(preset)?.get(note.key);
  if (!velocities?.has(note.velocity)) {
    fail("USAGE_NOT_DECLARED",
      `trimmed 음원 ${path.basename(fontPath)}에서 MIDI ${note.key}, velocity ${note.velocity} 사용이 세션을 열 때 선언되지 않았습니다`,
      {
        fontPath,
        preset: preset.name,
        key: note.key,
        velocity: note.velocity
      });
  }
}

function samePatch(actual, expected) {
  return !!actual
    && actual.program === expected.program
    && actual.bankMSB === expected.bankMSB
    && actual.bankLSB === expected.bankLSB
    && actual.isGMGSDrum === expected.isGMGSDrum
    && actual.isDrum === expected.isDrum
    && actual.name === expected.name;
}

function setPitchRange(synth, channel) {
  // RPN 0,0 = pitch bend sensitivity. 공개 MIDI API만 써서 ±12 semitone로 맞춘다.
  synth.controllerChange(channel, MIDIControllers.registeredParameterMSB, 0);
  synth.controllerChange(channel, MIDIControllers.registeredParameterLSB, 0);
  synth.controllerChange(channel, MIDIControllers.dataEntryMSB, PITCH_RANGE_SEMITONES);
  synth.controllerChange(channel, MIDIControllers.dataEntryLSB, 0);
  // RPN null — 뒤이은 data-entry가 실수로 pitch range를 바꾸지 않게 선택을 해제한다.
  synth.controllerChange(channel, MIDIControllers.registeredParameterMSB, 127);
  synth.controllerChange(channel, MIDIControllers.registeredParameterLSB, 127);
}

function configureChannel(synth, channelIndex, wantedPreset) {
  while (synth.midiChannels.length <= channelIndex) synth.createMIDIChannel();
  const channel = synth.midiChannels[channelIndex];
  channel.stopAllNotes(true);

  if (wantedPreset.isGMGSDrum) {
    channel.setDrums(true);
    synth.programChange(channelIndex, wantedPreset.program);
  } else {
    // channel 10 계열은 reset 뒤 drum 상태일 수 있다. 먼저 해제한 뒤 실제 XG/GM2
    // drum bank(120/127)나 melodic bank를 정확히 고른다.
    if (channel.drumChannel) channel.setDrums(false);
    synth.controllerChange(channelIndex, MIDIControllers.bankSelect, wantedPreset.bankMSB);
    synth.controllerChange(channelIndex, MIDIControllers.bankSelectLSB, wantedPreset.bankLSB);
    synth.programChange(channelIndex, wantedPreset.program);
  }

  // SoundBankManager 자체에는 GM/GS 호환용 replacement 규칙이 있다. 최종 선택을
  // 다시 대조하지 않으면 "성공했지만 다른 악기"가 될 수 있으므로 여기서 차단한다.
  if (!samePatch(channel.preset, wantedPreset)) {
    fail("PRESET_FALLBACK_BLOCKED",
      `SpessaSynth가 "${wantedPreset.name}" 대신 다른 프리셋을 선택하려 했습니다 — 렌더를 중단했습니다`,
      {
        requested: {
          name: wantedPreset.name, bankMSB: wantedPreset.bankMSB, bankLSB: wantedPreset.bankLSB,
          program: wantedPreset.program, isGMGSDrum: wantedPreset.isGMGSDrum, isDrum: wantedPreset.isDrum
        },
        selected: channel.preset ? {
          name: channel.preset.name, bankMSB: channel.preset.bankMSB, bankLSB: channel.preset.bankLSB,
          program: channel.preset.program, isGMGSDrum: channel.preset.isGMGSDrum,
          isDrum: channel.preset.isDrum
        } : null
      });
  }
  setPitchRange(synth, channelIndex);
}

function unsupportedTrackControls(track) {
  if (track === undefined || track === null) return;
  if (typeof track !== "object" || Array.isArray(track))
    fail("INVALID_RENDER_REQUEST", "track은 객체여야 합니다", { track });
  const unsupported = [];
  // Aria의 attack/release는 절대 초로 native envelope를 교체한다. SpessaSynth의
  // CC73/72는 기존 SoundFont generator에 offset을 더하는 기능이라 같은 뜻이 아니다.
  // 따라서 CC로 그럴듯하게 근사해 버리지 않고 adapter 경계에서 명시적으로 실패한다.
  if (track.attack !== undefined && track.attack !== null) unsupported.push("attack");
  if (track.release !== undefined && track.release !== null) unsupported.push("release");
  if (unsupported.length) {
    fail("CAPABILITY_UNSUPPORTED",
      `SpessaSynth adapter는 Aria의 절대시간 ${unsupported.join("/")} override를 아직 정확히 보존하지 못합니다 — 조용히 근사하지 않았습니다`,
      { controls: unsupported });
  }
}

function normalizeRenderNotes(notes, length) {
  if (!Array.isArray(notes)) fail("INVALID_RENDER_REQUEST", "notes는 배열이어야 합니다", { notes });
  return notes.map((note, index) => {
    const where = `notes[${index}]`;
    if (!note || typeof note !== "object" || Array.isArray(note))
      fail("INVALID_RENDER_REQUEST", `${where}는 노트 객체여야 합니다`, { note });
    const startSample = integer(note.startSample, `${where}.startSample`, 0, Math.max(0, length - 1));
    const endSample = integer(note.endSample, `${where}.endSample`, 1, length);
    if (endSample <= startSample)
      fail("INVALID_RENDER_REQUEST", `${where}.endSample은 startSample보다 커야 합니다`, { startSample, endSample });
    const key = integer(note.key, `${where}.key`, 0, 127);
    const velocity = integer(note.velocity, `${where}.velocity`, 1, 127);
    const bend = note.bend === undefined || note.bend === null ? 0
      : finite(note.bend, `${where}.bend`, -PITCH_RANGE_SEMITONES, PITCH_RANGE_SEMITONES);
    const gain = note.gain === undefined || note.gain === null ? 1
      : finite(note.gain, `${where}.gain`, 0, MAX_GAIN);
    return { index, startSample, endSample, key, velocity, bend, gain, channel: 0 };
  }).sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample || a.index - b.index);
}

function assignBendLanes(notes) {
  // Per-note pitch 상태는 channel+MIDI key 단위다. 같은 pitch에서 둘 중 하나라도
  // bend를 가지면 gate가 겹치지 않아도 같은 channel을 다시 쓰지 않는다. SoundFont의
  // native release tail이 남은 동안 다음 noteOn의 center reset이 꼬리 pitch를 바꾸기 때문이다.
  // 서로 다른 key는 SpessaSynth의 per-note pitchWheel을 써서 같은 lane을 공유할 수 있다.
  const lanes = [];
  for (const note of notes) {
    let laneIndex = lanes.findIndex(lane => {
      const sameKey = lane.get(note.key) ?? [];
      return !sameKey.some(other => note.bend !== 0 || other.bend !== 0);
    });
    if (laneIndex < 0) {
      laneIndex = lanes.length;
      lanes.push(new Map());
    }
    const lane = lanes[laneIndex];
    if (!lane.has(note.key)) lane.set(note.key, []);
    lane.get(note.key).push(note);
    note.channel = laneIndex;
  }
  return Math.max(1, lanes.length);
}

function wheelValue(bendSemitones) {
  return Math.max(0, Math.min(16383,
    Math.round(8192 + (bendSemitones / PITCH_RANGE_SEMITONES) * 8192)));
}

function eventTable(notes) {
  const starts = new Map(), ends = new Map(), frames = new Set([0]);
  for (const note of notes) {
    if (!starts.has(note.startSample)) starts.set(note.startSample, []);
    if (!ends.has(note.endSample)) ends.set(note.endSample, []);
    starts.get(note.startSample).push(note);
    ends.get(note.endSample).push(note);
    frames.add(note.startSample);
    frames.add(note.endSample);
  }
  return { starts, ends, frames: [...frames].sort((a, b) => a - b) };
}

function triggerNote(synth, note) {
  // pitch 상태가 이전 같은-key 보이스에서 남았을 수 있으므로 noteOn 전에 항상 중앙으로 돌린다.
  synth.pitchWheel(note.channel, 8192, note.key);
  if (note.gain === 1) {
    synth.noteOn(note.channel, note.key, note.velocity);
    return;
  }
  const modifier = new KeyModifier();
  modifier.gain = note.gain;
  synth.keyModifierManager.addMapping(note.channel, note.key, modifier);
  try { synth.noteOn(note.channel, note.key, note.velocity); }
  finally { synth.keyModifierManager.deleteMapping(note.channel, note.key); }
}

function validatePcm(left, right, notes, details) {
  let peak = 0, nonzero = 0, stereoDifference = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i], r = right[i];
    if (!Number.isFinite(l) || !Number.isFinite(r))
      fail("PCM_INVALID", `SpessaSynth가 유효하지 않은 PCM을 만들었습니다 (sample ${i})`,
        { ...details, sample: i, left: l, right: r });
    const a = Math.abs(l), b = Math.abs(r);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
    if (l !== 0 || r !== 0) nonzero++;
    stereoDifference += Math.abs(l - r);
  }
  if (notes.length && nonzero === 0)
    fail("PCM_SILENT", "노트가 있지만 SpessaSynth 출력이 완전한 무음입니다 — 성공으로 처리하지 않았습니다", details);
  return { peak, nonzeroSamples: nonzero, stereoMeanDifference: left.length ? stereoDifference / left.length : 0 };
}

/**
 * SoundFont 하나를 단독 소유하는 SpessaSynth offline session을 연다.
 *
 * usages: [{ preset, notes: [{ key, velocity }] }]
 * renderTrack: {
 *   preset, track?, length,
 *   notes: [{ startSample, endSample, key, velocity, bend?, gain? }]
 * }
 */
export function openSpessaSession(fontPath, sampleRate = 44100, usages = []) {
  if (typeof fontPath !== "string" || !fontPath.trim())
    fail("ASSET_MISSING", "fontPath가 비어 있습니다", { fontPath });
  finite(sampleRate, "sampleRate", 8000, 192000);
  if (!Array.isArray(usages))
    fail("INVALID_RENDER_REQUEST", "usages는 배열이어야 합니다", { usages });

  const resolvedPath = path.resolve(fontPath);
  let raw;
  try { raw = fs.readFileSync(resolvedPath); }
  catch (e) {
    fail(e.code === "ENOENT" ? "ASSET_MISSING" : "ASSET_UNREADABLE",
      `음원 파일을 읽지 못했습니다: ${resolvedPath}`, { fontPath: resolvedPath, causeCode: e.code }, e);
  }

  // Node readFile Buffer는 대개 exact ArrayBuffer지만, pooled/subarray인 경우 byteOffset 바깥의
  // 데이터를 parser에 넘기지 않도록 필요한 범위만 한 번 복사한다.
  const arrayBuffer = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
    ? raw.buffer
    : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  let bank;
  try { bank = SoundBankLoader.fromArrayBuffer(arrayBuffer); }
  catch (e) {
    fail("ASSET_CORRUPT", `음원 ${path.basename(resolvedPath)}을 해석하지 못했습니다: ${e.message}`,
      { fontPath: resolvedPath }, e);
  }

  let synth = null, bankOwnedBySynth = false;
  try {
    // BasicSample.isCompressed는 SpessaSynth가 공개한 정확한 SF3/Vorbis 표식이다.
    // 확장자나 SoundFont 버전으로 추측하지 않고 실제 압축 sample이 있을 때만 거부한다.
    // PCM-only render 경로는 decoder promise와 무관하므로 완전히 동기적으로 열 수 있다.
    const compressedSamples = bank.samples.filter(sample => sample.isCompressed === true);
    if (compressedSamples.length) {
      fail("CAPABILITY_UNSUPPORTED",
        `동기 SpessaSynth adapter는 압축 SoundFont sample을 아직 지원하지 않습니다 (${compressedSamples.length}개)`,
        {
          capability: "compressed-soundfont-sample",
          fontPath: resolvedPath,
          compressedSamples: compressedSamples.length,
          sampleNames: compressedSamples.slice(0, 8).map(sample => sample.name)
        });
    }

    const presets = new Map();
    const getPreset = spec => {
      const request = normalizePreset(spec);
      const key = presetKey(request);
      let selected = presets.get(key);
      if (!selected) {
        selected = exactPreset(bank, request, resolvedPath);
        presets.set(key, selected);
      }
      return selected;
    };

    // null은 범용 session(usages=[]), Map은 선언된 조합만 허용하는 trimmed session이다.
    // BasicPreset 객체를 key로 써야 bank.trim이 정확한 preset identity를 찾을 수 있다.
    const declarations = usages.length ? new Map() : null;
    for (let u = 0; u < usages.length; u++) {
      const usage = usages[u];
      if (!usage || typeof usage !== "object" || Array.isArray(usage))
        fail("INVALID_RENDER_REQUEST", `usages[${u}]는 {preset, notes} 객체여야 합니다`, { usage });
      const selected = getPreset(usage.preset);
      if (usage.notes !== undefined && !Array.isArray(usage.notes))
        fail("INVALID_RENDER_REQUEST", `usages[${u}].notes는 배열이어야 합니다`, { notes: usage.notes });
      let keys = declarations.get(selected);
      if (!keys) {
        keys = new Map();
        declarations.set(selected, keys);
      }
      for (let n = 0; n < (usage.notes ?? []).length; n++) {
        const note = validateUsageNote(usage.notes[n], `usages[${u}].notes[${n}]`);
        let velocities = keys.get(note.key);
        if (!velocities) {
          velocities = new Set();
          keys.set(note.key, velocities);
        }
        if (velocities.has(note.velocity)) continue;
        // trim 전에 원본 bank에서 정확한 key/velocity voice가 존재하는지 검증한다.
        ensureVoice(selected, note, resolvedPath);
        velocities.add(note.velocity);
      }
    }

    const samplesBefore = bank.samples.length;
    const presetsBefore = bank.presets.length;
    const instrumentsBefore = bank.instruments.length;
    let declaredKeys = 0, declaredCombinations = 0;
    if (declarations !== null) {
      for (const keys of declarations.values()) {
        declaredKeys += keys.size;
        for (const velocities of keys.values()) declaredCombinations += velocities.size;
      }
      try { bank.trim(declarations); }
      catch (e) {
        fail("ENGINE_STATE_INVALID", `음원 ${path.basename(resolvedPath)}을 사용 범위에 맞게 줄이지 못했습니다: ${e.message}`,
          { fontPath: resolvedPath }, e);
      }
    }
    const bankTrim = Object.freeze({
      applied: declarations !== null,
      declaredPresets: declarations?.size ?? 0,
      declaredKeys,
      declaredCombinations,
      samplesBefore,
      samplesAfter: bank.samples.length,
      presetsBefore,
      presetsAfter: bank.presets.length,
      instrumentsBefore,
      instrumentsAfter: bank.instruments.length
    });

    // Exact preset/voice preflight와 optional trim을 모두 끝낸 뒤에야 manager가 bank를 소유한다.
    synth = new SpessaSynthProcessor(sampleRate, {
      maxBufferSize: SPESSA_QUANTUM,
      effectsEnabled: false,
      eventsEnabled: false,
      initialTime: 0
    });
    synth.soundBankManager.addSoundBank(bank, `aria:${resolvedPath}`, 0);
    bankOwnedBySynth = true;
    synth.setSystemParameter("effectsEnabled", false);
    synth.setSystemParameter("autoAllocateVoices", true);

    let closed = false, rendering = false;
    const session = {
      engine: { id: SPESSA_ENGINE_ID, version: SPESSA_VERSION, quantum: SPESSA_QUANTUM, bankTrim },
      fontPath: resolvedPath,
      sampleRate,

      renderTrack({ preset, track, notes, length } = {}) {
        if (closed) fail("SESSION_CLOSED", "이미 닫힌 SpessaSynth session입니다", { fontPath: resolvedPath });
        if (rendering) fail("RENDER_BUSY", "같은 SpessaSynth session에서 렌더를 동시에 실행할 수 없습니다", { fontPath: resolvedPath });
        integer(length, "length", 1, 0x7fffffff);
        unsupportedTrackControls(track);
        const selected = getPreset(preset);
        const planned = normalizeRenderNotes(notes, length);
        for (const note of planned) {
          ensureDeclaredUsage(declarations, selected, note, resolvedPath);
          ensureVoice(selected, note, resolvedPath);
        }
        const laneCount = assignBendLanes(planned);
        const { starts, ends, frames } = eventTable(planned);

        rendering = true;
        try {
          synth.stopAllChannels(true);
          synth.keyModifierManager.clearMappings();
          synth.reset();
          synth.setSystemParameter("effectsEnabled", false);
          for (let channel = 0; channel < laneCount; channel++) configureChannel(synth, channel, selected);

          const left = new Float32Array(length), right = new Float32Array(length);
          const activeBends = new Map();
          let cursor = 0, eventIndex = 0, processCalls = 0, maxProcessBlock = 0;
          while (cursor < length) {
            // 현재 quantum 시작점의 pitch 값을 먼저 적용한다. event 경계에서는 noteOff 전에
            // bend endpoint가 들어가고, 새 noteOn은 그 다음 중앙값으로 초기화된다.
            for (const note of activeBends.values()) {
              const progress = Math.min(1, Math.max(0,
                (cursor - note.startSample) / (note.endSample - note.startSample)));
              synth.pitchWheel(note.channel, wheelValue(note.bend * progress), note.key);
            }

            for (const note of ends.get(cursor) ?? []) {
              if (note.bend !== 0) synth.pitchWheel(note.channel, wheelValue(note.bend), note.key);
              synth.noteOff(note.channel, note.key);
              activeBends.delete(note.index);
            }
            for (const note of starts.get(cursor) ?? []) {
              triggerNote(synth, note);
              if (note.bend !== 0) activeBends.set(note.index, note);
            }

            while (eventIndex < frames.length && frames[eventIndex] <= cursor) eventIndex++;
            const nextEvent = eventIndex < frames.length ? frames[eventIndex] : length;
            const count = Math.min(SPESSA_QUANTUM, nextEvent - cursor, length - cursor);
            if (count <= 0)
              fail("ENGINE_STATE_INVALID", "SpessaSynth event scheduler가 앞으로 진행하지 못했습니다",
                { cursor, nextEvent, eventIndex });
            synth.process(left, right, cursor, count);
            processCalls++;
            maxProcessBlock = Math.max(maxProcessBlock, count);
            cursor += count;
          }

          const pcm = validatePcm(left, right, planned,
            { fontPath: resolvedPath, preset: selected.name, frames: length });
          return {
            left, right,
            diagnostics: {
              engine: SPESSA_ENGINE_ID,
              engineVersion: SPESSA_VERSION,
              quantum: SPESSA_QUANTUM,
              processCalls,
              maxProcessBlock,
              effectsEnabled: false,
              preset: selected.name,
              bankTrim,
              laneCount,
              bendNotes: planned.filter(n => n.bend !== 0).length,
              // bend가 있는 같은 key는 gate 비중첩이어도 lane을 다시 쓰지 않으므로
              // native release tail은 후속 note의 center reset과 분리된다.
              bendReleaseTail: "same-key-isolated-endpoint-held",
              ...pcm
            }
          };
        } finally {
          synth.keyModifierManager.clearMappings();
          synth.stopAllChannels(true);
          rendering = false;
        }
      },

      close() {
        if (closed) return;
        closed = true;
        synth.destroySynthProcessor();
      }
    };
    return session;
  } catch (e) {
    try {
      if (synth && bankOwnedBySynth) synth.destroySynthProcessor();
      else bank?.destroySoundBank();
    } catch { /* 원래 오류를 보존한다 */ }
    throw e;
  }
}
