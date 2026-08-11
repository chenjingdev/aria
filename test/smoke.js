// aria — 스모크 테스트: 모델·렌더·파일 형식 무결성
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createTestSoundfonts } from "./soundfont-fixture.js";

const soundfonts = createTestSoundfonts("aria-smoke-sf2");
process.env.ARIA_SF2 = soundfonts.defaultPath;
process.env.ARIA_DATA_DIR = soundfonts.dataDir;
process.on("exit", soundfonts.cleanup);

const {
  createSong, validateSong, noteToMidi, totalBars, songText, effectiveArticulation
} = await import("../src/song.js");
const { renderRange } = await import("../src/sampler-renderer.js");
const { wavBuffer } = await import("../src/renderer.js");
const { midiBuffer } = await import("../src/midi.js");
const { guessPreset } = await import("../src/midi-import.js");
const {
  TEMPLATES, SF_PRESETS, SF_DRUM_KITS,
  presetExists, isSfPreset, isSfDrumKit, drumPieces
} = await import("../src/presets.js");

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log("aria 스모크 테스트");

ok("피치 변환", () => {
  assert.equal(noteToMidi("C4"), 60);
  assert.equal(noteToMidi("F#3"), 54);
  assert.equal(noteToMidi("Bb2"), 46);
  assert.equal(noteToMidi("H4"), null);
  assert.equal(noteToMidi("Fmaj7"), null);
});

ok("템플릿으로 곡 생성", () => {
  const s = createSong({ template: "citypop", title: "테스트" });
  assert.equal(s.tracks.length, 4);
  assert.equal(s.bpm, 96);
  assert.throws(() => createSong({ template: "없는거" }), /템플릿/);
});

const song = createSong({ template: "citypop", title: "smoke" });
song.tracks[0].notes = [ // Drums (sf-band-kit)
  { bar: 1, beat: 0, pitch: "kick", dur: 0.25, vel: 110 },
  { bar: 1, beat: 1, pitch: "hhc", dur: 0.25, vel: 70 },
  { bar: 1, beat: 2, pitch: "snare", dur: 0.25, vel: 100 },
  { bar: 2, beat: 0, pitch: "kick", dur: 0.25, vel: 110 },
  { bar: 2, beat: 2, pitch: "clap", dur: 0.25, vel: 90 }
];
song.tracks[1].notes = [ // Bass
  { bar: 1, beat: 0, pitch: "F2", dur: 1.5, vel: 100 },
  { bar: 2, beat: 0, pitch: "A2", dur: 1.5, vel: 100 }
];
song.tracks[2].notes = [ // E.Piano — Fmaj7 코드
  { bar: 1, beat: 0, pitch: "F3", dur: 4, vel: 85 },
  { bar: 1, beat: 0, pitch: "A3", dur: 4, vel: 85 },
  { bar: 1, beat: 0, pitch: "C4", dur: 4, vel: 85 },
  { bar: 1, beat: 0, pitch: "E4", dur: 4, vel: 85 }
];
song.tracks[3].notes = [{ bar: 2, beat: 0, pitch: "A4", dur: 2, vel: 95 }];

ok("곡 검증 통과 + 라운드트립", () => {
  const v = validateSong(JSON.parse(songText(validateSong(song))));
  assert.equal(v.tracks.reduce((s, t) => s + t.notes.length, 0), 12);
  assert.equal(totalBars(v), 8);
});

ok("검증이 불량 입력을 거부", () => {
  assert.throws(() => validateSong({ ...song, bpm: 999 }), /bpm/);
  const bad = structuredClone(song);
  bad.tracks[2].notes.push({ bar: 1, beat: 0, pitch: "Fmaj7", dur: 1, vel: 90 });
  assert.throws(() => validateSong(bad), /pitch/);
  const badDrum = structuredClone(song);
  badDrum.tracks[0].notes.push({ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 });
  assert.throws(() => validateSong(badDrum), /드럼 킷/);
  const badBeat = structuredClone(song);
  badBeat.tracks[1].notes.push({ bar: 1, beat: 4, pitch: "C2", dur: 1, vel: 90 });
  assert.throws(() => validateSong(badBeat), /beat/);
});

let rendered;
ok("2마디 렌더 — 무음·NaN·클리핑 없음", () => {
  rendered = renderRange(validateSong(song), 1, 2);
  const { left, right, sr, duration } = rendered;
  assert.equal(left.length, right.length);
  assert.ok(duration > 4.9 && duration < 12, `duration=${duration}`); // 2마디(5초) + 가장 긴 SoundFont 잔향
  let peak = 0, sum = 0;
  for (let i = 0; i < left.length; i++) {
    assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), `NaN at ${i}`);
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    sum += Math.abs(left[i]);
  }
  assert.ok(peak > 0.05, `무음에 가까움 peak=${peak}`);
  assert.ok(peak <= 1.0, `클리핑 peak=${peak}`);
  assert.ok(sum / left.length > 0.001, "평균 에너지가 너무 낮음");
});

ok("WAV 버퍼 형식", () => {
  const buf = wavBuffer(rendered.left, rendered.right, rendered.sr);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt16LE(22), 2); // 스테레오
  assert.equal(buf.readUInt32LE(24), 44100);
  assert.equal(buf.length, 44 + rendered.left.length * 4);
});

ok("MIDI 버퍼 형식", () => {
  const buf = midiBuffer(validateSong(song));
  assert.equal(buf.toString("ascii", 0, 4), "MThd");
  assert.equal(buf.readUInt16BE(8), 1);  // format 1
  assert.equal(buf.readUInt16BE(10), 5); // 템포 트랙 + 4 트랙
  assert.equal(buf.readUInt16BE(12), 480);
  assert.ok(buf.includes(Buffer.from("MTrk")));
});

ok("MIDI가 같은 key 드럼 피스의 원래 CC 상태를 보존", () => {
  const s = createSong({});
  s.tracks = [{
    name: "하이햇", preset: "salamander-all-full", volume: 0.8, pan: 0,
    notes: [
      { bar: 1, beat: 0, pitch: "hi-hat-closed", dur: 0.25, vel: 100 },
      { bar: 1, beat: 1, pitch: "hi-hat-semi-open-7", dur: 0.25, vel: 101 }
    ]
  }];
  const buf = midiBuffer(validateSong(s));
  const closedCc = buf.indexOf(Buffer.from([0xb9, 64, 0]));
  const closedOn = buf.indexOf(Buffer.from([0x99, 42, 100]));
  const openCc = buf.indexOf(Buffer.from([0xb9, 64, 118]));
  const openOn = buf.indexOf(Buffer.from([0x99, 42, 101]));
  assert.ok(closedCc >= 0 && closedCc < closedOn, "닫힌 하이햇 CC64=0이 note-on보다 먼저 없음");
  assert.ok(openCc >= 0 && openCc < openOn, "반열림 하이햇 CC64=118이 note-on보다 먼저 없음");
});

ok("MIDI는 명시적 녹음 주법을 거부하고 implicit/null 기본 주법은 GM 근사를 허용", () => {
  const [presetId, preset] = Object.entries(SF_PRESETS).find(([, item]) =>
    item.articulations && item.defaultArticulation &&
    Object.hasOwn(item.articulations, item.defaultArticulation));
  assert.ok(presetId, "MIDI 주법 정책을 검증할 키스위치 프리셋이 없음");
  const base = {
    title: "portable-midi-articulation", bpm: 100, timeSig: [4, 4], tempoMap: [],
    tracks: [{
      name: "주법 악기", preset: presetId, volume: 0.8, pan: 0,
      notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 }]
    }]
  };

  const implicit = validateSong(base);
  assert.equal(midiBuffer(implicit).toString("ascii", 0, 4), "MThd",
    "articulation을 생략한 기본 주법이 MIDI로 내보내지지 않음");
  const nullDefault = validateSong({
    ...base, tracks: [{ ...base.tracks[0], articulation: null }]
  });
  assert.equal(midiBuffer(nullDefault).toString("ascii", 0, 4), "MThd",
    "articulation:null 기본 주법이 MIDI로 내보내지지 않음");

  const explicit = validateSong({
    ...base, tracks: [{ ...base.tracks[0], articulation: preset.defaultArticulation }]
  });
  assert.throws(() => midiBuffer(explicit), error => {
    assert.match(error.message, /MIDI 내보내기를 중단/);
    assert.match(error.message, /주법\/키스위치/);
    assert.match(error.message, /WAV/);
    assert.match(error.message, /articulation:null/);
    assert.match(error.message, new RegExp(preset.defaultArticulation));
    return true;
  });

  // 소리를 내지 않는 빈 트랙의 메타데이터는 portable MIDI에서 유실될 연주가 없다.
  const unusedExplicit = validateSong({
    ...base,
    tracks: [
      { ...base.tracks[0], articulation: preset.defaultArticulation, notes: [] },
      { name: "기본 악기", preset: "sf-piano-gm", volume: 0.8, pan: 0,
        notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 }] }
    ]
  });
  assert.equal(midiBuffer(unusedExplicit).toString("ascii", 0, 4), "MThd");

  const unusedRegion = validateSong({
    ...base,
    tracks: [{
      ...base.tracks[0],
      articulationRegions: [{ from: 2, to: 3, articulation: preset.defaultArticulation }]
    }]
  });
  assert.equal(midiBuffer(unusedRegion).toString("ascii", 0, 4), "MThd",
    "노트가 시작하지 않는 빈 구간 주법이 portable MIDI를 불필요하게 막음");

  const usedRegion = validateSong({
    ...base,
    tracks: [{
      ...base.tracks[0],
      articulationRegions: [{ from: 1, to: 1, articulation: preset.defaultArticulation }]
    }]
  });
  assert.throws(() => midiBuffer(usedRegion), error => {
    assert.match(error.message, /1마디=/);
    assert.match(error.message, /set_region_articulation/);
    assert.match(error.message, /WAV/);
    return true;
  });
});

ok("모든 템플릿·프리셋이 유효", () => {
  for (const id of Object.keys(TEMPLATES)) {
    const s = createSong({ template: id });
    validateSong(s);
    assert.ok(s.tracks.length >= 3, `${id} 트랙 부족`);
    for (const track of s.tracks) {
      assert.ok(isSfPreset(track.preset) || isSfDrumKit(track.preset),
        `${id}/${track.name}가 SoundFont가 아닌 프리셋 ${track.preset}을 사용함`);
    }
  }
});

ok("삭제한 내장 합성 프리셋 ID를 더는 인정하지 않음", () => {
  const removed = [
    "soft-piano", "fm-epiano", "wurli", "dx-lush", "music-box",
    "finger-bass", "synth-bass", "airy-synth", "strings", "pluck",
    "saw-lead", "square-lead", "organ",
    "lofi-kit", "acoustic-kit", "e808-kit"
  ];
  for (const id of removed) assert.equal(presetExists(id), false, `${id}가 아직 레지스트리에 남아 있음`);
});

// ---------- 리뷰에서 확정된 결함의 회귀 테스트 ----------
const { state, ops, runOp, subscribe, addLog, loadAutosave } = await import("../src/core.js");

ok("같은 밀리초의 반복 작업 기록도 고유 ID를 가진다", () => {
  const n = state.log.length;
  addLog("gui", "같은 작업"); addLog("gui", "같은 작업");
  const [a, b] = state.log.slice(-2);
  assert.ok(a.id && b.id && a.id !== b.id, "반복 로그 ID가 충돌함");
  state.log.splice(n);
});

ok("set_track 실패가 상태를 오염시키지 않음", () => {
  state.song = validateSong(song);
  assert.throws(() => ops.set_track({ track: "Bass", volume: 5 }), /volume/);
  assert.equal(state.song.tracks[1].volume, 0.85); // 원래 값 유지
  ops.add_notes({ track: "Bass", notes: [{ bar: 3, beat: 0, pitch: "C2", dur: 1 }] }); // 후속 연산 정상
  assert.throws(() => ops.set_track({ track: "Bass", new_name: "   " }), /name/);
  assert.equal(state.song.tracks[1].name, "Bass");
});

ok("add_notes 실패가 부분 반영되지 않음", () => {
  state.song = validateSong(song);
  const before = state.song.tracks[1].notes.length;
  assert.throws(() => ops.add_notes({ track: "Bass", notes: [
    { bar: 4, beat: 0, pitch: "C2", dur: 1 }, { bar: 4, beat: 1, pitch: "잘못됨", dur: 1 }
  ] }), /pitch/);
  assert.equal(state.song.tracks[1].notes.length, before);
});

ok("runOp가 프로토타입 키를 거부", () => {
  assert.throws(() => runOp("hasOwnProperty", {}, "gui"), /알 수 없는 명령/);
  assert.throws(() => runOp("toString", {}, "gui"), /알 수 없는 명령/);
});

ok("new_song이 HTTP 경로의 불량 bpm을 거부", () => {
  assert.throws(() => ops.new_song({ bpm: "빠르게" }), /bpm/);
  assert.throws(() => ops.new_song({ bpm: 0 }), /bpm/);
});

ok("강약 흐름이 시간에 따라 점층되고 한 번에 되돌아간다", () => {
  const s = createSong({ title: "강약 그래프" });
  s.tracks = [{ name:"현악", preset:"sf-strings", volume:0.8, pan:0, notes:[
    { bar:1, beat:0, pitch:"C4", dur:1, vel:90 },
    { bar:1, beat:1, pitch:"E4", dur:1, vel:90 },
    { bar:1, beat:1, pitch:"G4", dur:1, vel:72 }, // 같은 시각 화음도 그래프 목표값을 함께 따른다
    { bar:1, beat:3, pitch:"C5", dur:1, vel:90 },
    { bar:2, beat:0, pitch:"D5", dur:1, vel:77 }  // 그래프 범위 밖 — 바뀌면 안 된다
  ] }];
  state.song = validateSong(s);
  const before = JSON.stringify(state.song);
  const ids = state.song.tracks[0].notes.slice(0, 4).map(n => ({ bar:n.bar, beat:n.beat, pitch:n.pitch, dur:n.dur }));
  runOp("set_velocity", { track:"현악", notes:ids, vel:40, to_vel:120 }, "gui");
  assert.deepEqual(state.song.tracks[0].notes.map(n => n.vel), [40, 67, 67, 120, 77]);
  const shaped = JSON.stringify(state.song);
  runOp("undo_edit", {}, "gui");
  assert.equal(JSON.stringify(state.song), before, "그래프 한 번이 undo 여러 단계로 갈라짐");
  runOp("redo_edit", {}, "gui");
  assert.equal(JSON.stringify(state.song), shaped, "redo가 강약 흐름을 복원하지 못함");
});

ok("멜로디 트랙 16개는 MIDI 내보내기 거부", () => {
  const s = createSong({});
  s.tracks = Array.from({ length: 16 }, (_, i) =>
    ({ name: `t${i}`, preset: "sf-pizzicato", volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 }] }));
  assert.throws(() => midiBuffer(validateSong(s)), /15개/);
});

ok("루프용 tail:0 렌더는 구간 길이와 일치", () => {
  const r = renderRange(validateSong(song), 1, 2, { tail: 0 });
  assert.ok(Math.abs(r.duration - r.rangeSec) < 0.01, `duration=${r.duration} rangeSec=${r.rangeSec}`);
});

ok("과도한 렌더 구간 거부", () => {
  const s = createSong({});
  s.bpm = 20; // 999마디 × 4박 × 3초 ≈ 3.3시간 — 상한(10분)을 확실히 넘긴다
  s.tracks = [{ name: "t", preset: "sf-pizzicato", volume: 0.8, pan: 0, notes: [{ bar: 999, beat: 0, pitch: "C4", dur: 1, vel: 90 }] }];
  state.song = validateSong(s);
  assert.throws(() => ops.play({}), /너무 깁니다/);
  assert.throws(() => ops.export({ format: "wav", path: "/tmp/aria-must-not-exist" }), /너무 깁니다/);
});

ok("라이브러리 보관·불러오기 라운드트립 + 자동 보존", () => {
  state.song = validateSong(song);
  ops.save_song({ name: "라이브러리 테스트" });
  ops.new_song({ template: "lofi", title: "잠깐 곡" }); // save_song된 곡이 있으니 자동 보존 대상 아님(노트 0)
  ops.add_notes({ track: "Bass", notes: [{ bar: 1, beat: 0, pitch: "C2", dur: 1 }] });
  ops.load_song({ name: "라이브러리 테스트" });
  assert.equal(state.song.title, "라이브러리 테스트");
  const list = ops.list_songs();
  assert.ok(list.includes("라이브러리 테스트"));
  assert.ok(list.includes("잠깐 곡")); // 전환하면서 자동 보존됨
  assert.throws(() => ops.load_song({ name: "없는 곡" }), /라이브러리에/);
});

// ---------- 표현·템포·결정성 (2차 개선분) ----------
const { tempoSegments, beatToSec, bpmAtBeat } = await import("../src/song.js");

const rms = (buf, from = 0, to = buf.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const peakOf = buf => { let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); return p; };
// 노트 한 개짜리 곡 — 표현 파라미터를 격리해서 재는 용도
const oneNote = (over = {}, vel = 100, preset = "sf-organ", dur = 1) => validateSong({
  title: "표현시험", bpm: 120, timeSig: [4, 4],
  tracks: [{ name: "t", preset, volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "C4", dur, vel }], ...over }]
});

ok("렌더가 결정적 — play와 export가 같은 파형을 낸다", () => {
  const s = validateSong(song);
  const a = renderRange(s, 1, 2), b = renderRange(s, 1, 2);
  assert.equal(a.left.length, b.left.length);
  for (let i = 0; i < a.left.length; i++) {
    assert.equal(a.left[i], b.left[i], `L 샘플 ${i}가 렌더마다 다름`);
    assert.equal(a.right[i], b.right[i], `R 샘플 ${i}가 렌더마다 다름`);
  }
});

ok("velRange가 velocity 다이내믹 폭을 넓힌다", () => {
  const ratio = (over) =>
    peakOf(renderRange(oneNote(over, 120), 1, 1, { tail: 0.4 }).left) /
    peakOf(renderRange(oneNote(over, 20), 1, 1, { tail: 0.4 }).left);
  const flat = ratio({ velRange: 0 });
  const base = ratio({});
  const wide = ratio({ velRange: 1 });
  // 완전한 SF2 엔진에서는 velocity가 음량뿐 아니라 샘플 layer·modulator도 고르므로
  // 특정 dB/배수로 고정하지 않는다. 여기서는 remap 방향과 순서만 검증한다.
  assert.ok(Math.abs(flat - 1) < 0.02, `velRange:0이 중간 velocity로 모이지 않음: ${flat.toFixed(2)}배`);
  assert.ok(base > flat * 1.2, `기본 폭이 평탄값과 구분되지 않음: ${base.toFixed(2)}배`);
  assert.ok(wide > base * 1.05, `velRange가 원본 강약 폭을 못 넓힘 (${base.toFixed(2)}→${wide.toFixed(2)})`);
});

ok("velRange:0이면 velocity가 음량에 영향을 주지 않는다", () => {
  const loud = peakOf(renderRange(oneNote({ velRange: 0 }, 127), 1, 1, { tail: 0.4 }).left);
  const soft = peakOf(renderRange(oneNote({ velRange: 0 }, 1), 1, 1, { tail: 0.4 }).left);
  assert.ok(Math.abs(loud - soft) / loud < 0.01, `vel 1과 127의 차이가 남아 있음 (${soft} vs ${loud})`);
});

ok("예전 자체 엔진 전용 음색 필드를 저장 모델에서 제거", () => {
  const s = oneNote({ attack: 0.5, release: 2, vibrato: 0.4, ensemble: 3 });
  for (const key of ["attack", "release", "vibrato", "ensemble"])
    assert.equal(s.tracks[0][key], undefined, `${key}가 외부 엔진 모델에 남아 있음`);
});

ok("reverb 오버라이드가 트랙별로 먹는다", () => {
  const wetTail = over => {
    const r = renderRange(oneNote(over, 100, "sf-pizzicato", 0.25), 1, 1, { tail: 1.6 });
    return rms(r.left, Math.round(1.0 * r.sr), r.left.length);
  };
  assert.ok(wetTail({ reverb: 0.9 }) > wetTail({ reverb: 0 }) * 10, "리버브 센드가 반영되지 않음");
});

ok("리버브가 좌우로 퍼진다 — 잔향이 모노로 뭉치지 않음", () => {
  const r = renderRange(oneNote({ reverb: 0.9 }, 100, "sf-pizzicato", 0.25), 1, 1, { tail: 1.6 });
  const from = Math.round(1.0 * r.sr);
  let diff = 0, energy = 0;
  for (let i = from; i < r.left.length; i++) {
    diff += (r.left[i] - r.right[i]) ** 2;
    energy += r.left[i] ** 2 + r.right[i] ** 2;
  }
  assert.ok(energy > 0, "잔향이 없음");
  assert.ok(diff / energy > 0.05, `좌우 잔향이 사실상 동일(상관 ${(diff / energy).toFixed(4)}) — stereo spread 미적용`);
});

ok("템포 맵 — 계단식 변화의 초 계산", () => {
  const s = validateSong({ ...song, bpm: 120, tempoMap: [{ bar: 3, bpm: 60 }] });
  const segs = tempoSegments(s);
  assert.ok(Math.abs(beatToSec(segs, 8) - 4) < 1e-6, "1~2마디는 120bpm에서 4초");
  assert.ok(Math.abs(beatToSec(segs, 16) - 12) < 1e-6, "3~4마디는 60bpm이라 합계 12초");
  assert.equal(bpmAtBeat(segs, 0), 120);
  assert.equal(bpmAtBeat(segs, 8), 60);
});

ok("템포 맵 — 램프(rit.)의 초 계산", () => {
  const s = validateSong({ ...song, bpm: 120, tempoMap: [{ bar: 3, bpm: 60, ramp: true }] });
  const segs = tempoSegments(s);
  // 120→60으로 8박에 걸쳐 선형 감속: 60·8/(60-120)·ln(60/120) = 5.545초
  assert.ok(Math.abs(beatToSec(segs, 8) - 5.5452) < 0.001, `램프 구간 길이 ${beatToSec(segs, 8)}`);
  assert.ok(Math.abs(bpmAtBeat(segs, 4) - 90) < 1e-6, "중간 지점은 90bpm");
  // 램프가 없을 때(4초)보다 길고, 처음부터 60bpm(8초)보다는 짧다
  assert.ok(beatToSec(segs, 8) > 4 && beatToSec(segs, 8) < 8);
});

ok("템포 맵 검증이 불량 입력을 거부", () => {
  assert.throws(() => validateSong({ ...song, tempoMap: [{ bar: 2, bpm: 900 }] }), /bpm/);
  assert.throws(() => validateSong({ ...song, tempoMap: [{ bar: 0, bpm: 120 }] }), /bar/);
  assert.throws(() => validateSong({ ...song, tempoMap: [{ bar: 3, bpm: 90 }, { bar: 3, bpm: 100 }] }), /중복/);
  assert.throws(() => validateSong({ ...song, tempoMap: "빠르게" }), /tempoMap/);
});

ok("템포 변화가 렌더 길이에 반영된다", () => {
  const fast = validateSong({ ...song, bpm: 120, tempoMap: [] });
  const slow = validateSong({ ...song, bpm: 120, tempoMap: [{ bar: 2, bpm: 60 }] });
  const a = renderRange(fast, 1, 2, { tail: 0 }), b = renderRange(slow, 1, 2, { tail: 0 });
  assert.ok(Math.abs(a.rangeSec - 4) < 1e-6, `템포 변화 없음: ${a.rangeSec}초`);
  assert.ok(Math.abs(b.rangeSec - 6) < 1e-6, `2마디가 60bpm이면 4+... 아니라 6초여야: ${b.rangeSec}초`);
});

ok("MIDI에 템포 변화가 실린다", () => {
  const plain = midiBuffer(validateSong({ ...song, tempoMap: [] }));
  const stepped = midiBuffer(validateSong({ ...song, tempoMap: [{ bar: 3, bpm: 60 }] }));
  const ramped = midiBuffer(validateSong({ ...song, tempoMap: [{ bar: 5, bpm: 60, ramp: true }] }));
  const count = buf => { let n = 0; for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0x51) n++; return n; };
  assert.equal(count(plain), 1, "템포 이벤트는 기본 1개");
  assert.equal(count(stepped), 2, "계단 변화면 2개");
  assert.ok(count(ramped) > 5, `램프는 계단으로 근사돼 여러 개여야 함 (${count(ramped)}개)`);
});

ok("변박이 new_song에서 바로 된다", () => {
  const s = ops.new_song({ template: "lofi", time_sig: [7, 8] });
  assert.ok(s.includes("7/8"), s);
  assert.equal(beatsPerBarOf(state.song), 3.5);
  assert.throws(() => ops.new_song({ time_sig: [4, 5] }), /timeSig/);
  assert.throws(() => ops.new_song({ time_sig: [4] }), /time_sig/);
});
function beatsPerBarOf(s) { return s.timeSig[0] * (4 / s.timeSig[1]); }

ok("set_tempo가 기준 템포와 마디별 변화를 모두 다룬다", () => {
  ops.new_song({ template: "lofi", title: "템포시험" });
  ops.set_tempo({ bpm: 100 });
  assert.equal(state.song.bpm, 100);
  ops.set_tempo({ bpm: 60, from_bar: 9, ramp: true });
  assert.equal(state.song.tempoMap.length, 1);
  assert.equal(state.song.tempoMap[0].ramp, true);
  ops.set_tempo({ bpm: 140, from_bar: 9 }); // 같은 마디 재지정 = 덮어쓰기
  assert.equal(state.song.tempoMap.length, 1);
  assert.equal(state.song.tempoMap[0].bpm, 140);
  ops.set_tempo({ bpm: 90 }); // 기준 템포 변경이 변화점을 지우지 않음
  assert.equal(state.song.bpm, 90);
  assert.equal(state.song.tempoMap.length, 1);
  ops.set_tempo({ bpm: 70, from_bar: 17 });
  assert.throws(() => ops.clear_tempo({ from_bar: 3 }), /3마디에 템포 변화가 없습니다/);
  assert.equal(state.song.tempoMap.length, 2, "실패가 맵을 건드리지 않음");
  ops.clear_tempo({ from_bar: 9 });
  assert.equal(state.song.tempoMap.length, 1);
  ops.clear_tempo({});                                    // 전체 삭제
  assert.equal(state.song.tempoMap.length, 0);
  assert.equal(state.song.bpm, 90, "기준 템포는 남는다");
  assert.ok(ops.clear_tempo({}).includes("삭제할 템포 변화가 없습니다"));
});

ok("set_track이 음색 파라미터를 넣고 null로 되돌린다", () => {
  ops.new_song({ template: "lofi", title: "음색시험" });
  ops.set_track({ track: "Keys", eqHigh: 1.5, velRange: 1, reverb: 0.7 });
  const t = () => state.song.tracks.find(x => x.name === "Keys");
  assert.equal(t().eqHigh, 1.5);
  assert.equal(t().velRange, 1);
  ops.set_track({ track: "Keys", eqHigh: null });
  assert.equal(t().eqHigh, undefined, "null은 프리셋 기본값으로 되돌려야 함");
  assert.equal(t().velRange, 1, "다른 항목은 유지");
  assert.throws(() => ops.set_track({ track: "Keys", eqHigh: 99 }), /eqHigh/);
  assert.equal(t().velRange, 1, "실패가 상태를 오염시키지 않음");
});

const fsMod = await import("node:fs");

ok("긴 곡도 구간을 나눠 WAV로 내보낼 수 있다", () => {
  const s = createSong({ bpm: 60 });          // 4박 × 1초 = 마디당 4초
  s.tracks = [{ name: "t", preset: "sf-pizzicato", volume: 0.8, pan: 0, notes: [] }];
  for (let bar = 1; bar <= 200; bar++) s.tracks[0].notes.push({ bar, beat: 0, pitch: "C4", dur: 1, vel: 90 });
  state.song = validateSong(s);               // 200마디 × 4초 = 800초 > 600초 상한
  assert.throws(() => ops.export({ format: "wav", path: `${process.env.ARIA_DATA_DIR}/full` }), /너무 깁니다/);
  const out = ops.export({ format: "wav", path: `${process.env.ARIA_DATA_DIR}/part`, from_bar: 1, to_bar: 100 });
  assert.ok(out.includes("1~100마디"), out);
  assert.ok(fsMod.existsSync(`${process.env.ARIA_DATA_DIR}/part.wav`), "구간 WAV가 안 만들어짐");
});
ok("play가 레벨과 클리핑을 되돌려준다", () => {
  if (process.platform !== "darwin") return; // afplay 없는 환경은 건너뜀
  ops.new_song({ template: "lofi", title: "레벨시험" });
  ops.add_notes({ track: "Keys", notes: Array.from({ length: 24 }, (_, i) =>
    ({ bar: 1, beat: 0, pitch: `C${2 + (i % 5)}`, dur: 1, vel: 127 })) });
  // 완전한 SoundFont 엔진은 예전 모노 renderer보다 정상 출력이 작다. 레벨 경고 자체를
  // 검증하려는 시험이므로 트랙을 허용 상한(+6dB)까지 올려 리미터가 실제로 작동하게 한다.
  ops.set_track({ track: "Keys", volume: 2 });
  let levelEvent = null;
  const unsubscribe = subscribe(ev => { if (ev.type === "level") levelEvent = ev; });
  const out = ops.play({ from_bar: 1, to_bar: 1 });
  ops.stop(); unsubscribe();
  assert.ok(out.includes("피크"), `레벨 정보 없음: ${out}`);
  assert.ok(/소프트클립|헤드룸|리미터|왜곡/.test(out), `24개 겹친 노트인데 경고가 없음: ${out}`);
  assert.ok(levelEvent?.text?.startsWith("레벨:"), "열린 GUI로 레벨 이벤트가 전달되지 않음");
  assert.deepEqual([levelEvent.fromBar, levelEvent.toBar], [1, 1], "레벨 이벤트의 확인 구간이 다름");
});

// ---------- 리뷰에서 확정된 결함의 회귀 테스트 (2차) ----------

ok("SoundFont의 native release 꼬리를 하드컷하지 않는다", () => {
  const s = oneNote({}, 100, "sf-organ", 1);
  const r = renderRange(s, 1, 1);
  const tailPeak = peakOf(r.left.slice(-200));
  assert.ok(tailPeak < peakOf(r.left) * 0.01,
    `파일 끝이 하드컷됨 (마지막 피크가 전체의 ${(100 * tailPeak / peakOf(r.left)).toFixed(1)}%)`);
});

ok("외부 샘플러 출력이 긴 native 꼬리에서도 유한하다", () => {
  const r = renderRange(oneNote({}, 100, "sf-organ", 0.25), 1, 1);
  for (let i = 0; i < r.left.length; i++)
    assert.ok(Number.isFinite(r.left[i]) && Number.isFinite(r.right[i]), `NaN at ${i} (${(i / r.sr).toFixed(3)}초)`);
});

ok("시드가 제목·템포에 의존하지 않는다", () => {
  const base = validateSong(song);
  const renamed = validateSong({ ...song, title: "완전히 다른 제목" });
  const a = renderRange(base, 1, 2, { tail: 0 }), b = renderRange(renamed, 1, 2, { tail: 0 });
  for (let i = 0; i < a.left.length; i++)
    assert.equal(a.left[i], b.left[i], `제목만 바꿨는데 샘플 ${i}가 달라짐`);
});

ok("MIDI 램프가 오디오와 같은 시각에 끝난다", () => {
  // 트랙 0의 템포 이벤트로 tick→초 타임라인을 복원해 beatToSec와 대조
  const midiSeconds = (s, targetBeat) => {
    const buf = midiBuffer(s);
    const len = buf.readUInt32BE(18);          // 첫 MTrk 청크 길이
    const events = [];
    let p = 22, tick = 0;
    while (p < 22 + len) {
      let delta = 0, b;
      do { b = buf[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
      tick += delta;
      if (buf[p] === 0xff) {
        const type = buf[p+1], n = buf[p+2];
        if (type === 0x51) events.push({ tick, us: (buf[p+3] << 16) | (buf[p+4] << 8) | buf[p+5] });
        if (type === 0x2f) break;
        p += 3 + n;
      } else p += 3;
    }
    const targetTick = targetBeat * 480;
    let sec = 0, prev = 0, us = events[0].us;
    for (const e of events) {
      if (e.tick >= targetTick) break;
      sec += ((e.tick - prev) / 480) * (us / 1e6);
      prev = e.tick; us = e.us;
    }
    return sec + ((targetTick - prev) / 480) * (us / 1e6);
  };
  const cases = [
    { bpm: 60, tempoMap: [{ bar: 2, bpm: 180, ramp: true }], at: 4 },
    { bpm: 120, tempoMap: [{ bar: 5, bpm: 120 }, { bar: 9, bpm: 60, ramp: true }], at: 32 },
    { bpm: 20, timeSig: [1, 4], tempoMap: [{ bar: 2, bpm: 300, ramp: true }], at: 1 }
  ];
  for (const c of cases) {
    // 박자표가 바뀌면 기존 픽스처의 beat가 범위를 벗어나므로 최소 곡으로 잰다
    const s = validateSong({
      title: "midi-ramp", bpm: c.bpm, timeSig: c.timeSig ?? [4, 4], tempoMap: c.tempoMap,
      tracks: [{ name: "p", preset: "sf-piano", volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 96 }] }]
    });
    const audio = beatToSec(tempoSegments(s), c.at);
    const midi = midiSeconds(s, c.at);
    assert.ok(Math.abs(audio - midi) < 0.002,
      `${c.bpm}bpm 램프: 오디오 ${audio.toFixed(4)}s vs MIDI ${midi.toFixed(4)}s (차이 ${(midi-audio).toFixed(4)}s)`);
  }
});

ok("표현 파라미터가 숫자 아닌 값을 거부", () => {
  for (const bad of ["", "1.5", [], [1.5], true, {}])
    assert.throws(() => oneNote({ velRange: bad }), /velRange/, `velRange: ${JSON.stringify(bad)}가 통과됨`);
  assert.throws(() => oneNote({ eqHigh: 13 }), /eqHigh/);
});

ok("곡 범위 밖 구간은 무음 파일 대신 에러", () => {
  state.song = validateSong(song); // 8마디
  assert.throws(() => ops.play({ from_bar: 100 }), /곡 범위 밖/);
  assert.throws(() => ops.export({ format: "wav", from_bar: 50, to_bar: 60 }), /곡 범위 밖/);
  const out = ops.export({ format: "wav", from_bar: 2, to_bar: 999, path: `${process.env.ARIA_DATA_DIR}/clamped` });
  assert.ok(out.includes("2~8마디"), `끝 마디는 곡 길이로 접혀야 함: ${out}`);
});

ok("new_song 실패가 부수효과를 남기지 않음", () => {
  ops.new_song({ template: "lofi", title: "지켜야 할 곡" });
  ops.add_notes({ track: "Keys", notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1 }] });
  const before = ops.list_songs();
  assert.throws(() => ops.new_song({ bpm: 9999 }), /bpm/);
  assert.throws(() => ops.new_song({ time_sig: [4, 5] }), /timeSig/);
  assert.equal(state.song.title, "지켜야 할 곡", "실패가 현재 곡을 갈아치움");
  assert.equal(ops.list_songs(), before, "실패한 호출이 라이브러리에 썼음");
});

ok("set_tempo/clear_tempo가 불량 인자를 거부", () => {
  ops.new_song({ template: "lofi", title: "인자시험" });
  assert.throws(() => ops.set_tempo({ bpm: 100, from_bar: 5, ramp: "false" }), /ramp/);
  assert.throws(() => ops.clear_tempo({ from_bar: "5" }), /from_bar/);
  assert.throws(() => ops.clear_tempo({ from_bar: 0 }), /from_bar/);
});

ok("export가 실제로 쓴 파일만 보고한다", () => {
  state.song = validateSong(song);
  const dir = process.env.ARIA_DATA_DIR;
  const wav = ops.export({ format: "wav", from_bar: 1, to_bar: 2, path: `${dir}/only-wav` });
  assert.ok(!wav.includes("MIDI"), `WAV만 뽑았는데 MIDI 안내가 붙음: ${wav}`);
  assert.ok(!fsMod.existsSync(`${dir}/only-wav.mid`));
  const both = ops.export({ format: "both", from_bar: 1, to_bar: 2 });
  assert.ok(both.includes("곡 전체"), `both일 때 MIDI 범위 안내가 없음: ${both}`);
  // 경로를 안 주면 구간 접미사는 WAV에만 붙는다
  assert.ok(/smoke\.mid/.test(both) && /smoke-1-2마디\.wav/.test(both), both);
});

// ---------- SoundFont(sf-*) — 파일이 있을 때만 검사 ----------
const { sf2Available, SF2_PATH, fontStatus } = await import("../src/sf2.js");

ok("누락된 명시 SoundFont를 기본 폰트로 몰래 대체하지 않음", () => {
  const spec = { font: `__aria-smoke-missing-${process.pid}.sf2` };
  const status = fontStatus(spec);
  assert.equal(status.available, false);
  assert.equal(status.state, "missing");
});

ok("손상 파일과 없는 bank/program을 선택 전에 구분", () => {
  const corruptName = `corrupt-${process.pid}.sf2`;
  fsMod.writeFileSync(`${soundfonts.root}/${corruptName}`, "not a soundfont");
  const corrupt = fontStatus({ font: corruptName, gm: 0 });
  assert.equal(corrupt.available, false);
  assert.equal(corrupt.state, "corrupt");
  const absent = fontStatus({ font: "default.sf2", bank: 127, program: 127 });
  assert.equal(absent.available, false);
  assert.equal(absent.state, "program-missing");

  // RIFF 구조는 멀쩡하지만 sample header가 PCM 밖을 가리키는 경우도 선택 전에 막아야 한다.
  const boundsName = `corrupt-bounds-${process.pid}.sf2`;
  const bytes = fsMod.readFileSync(soundfonts.defaultPath);
  const shdr = bytes.indexOf(Buffer.from("shdr", "ascii"));
  assert.ok(shdr >= 0, "테스트 SoundFont의 shdr를 찾을 수 없음");
  bytes.writeUInt32LE(999999, shdr + 8 + 24); // 첫 sample의 end
  bytes.writeUInt32LE(999999, shdr + 8 + 32); // 첫 sample의 loopEnd
  fsMod.writeFileSync(`${soundfonts.root}/${boundsName}`, bytes);
  const bounds = fontStatus({ font: boundsName, gm: 0 });
  assert.equal(bounds.available, false);
  assert.equal(bounds.state, "corrupt");
  assert.match(bounds.reason, /sample data 범위/);
});

ok("모든 managed catalog와 GM·Philharmonia 선택지를 서로 대체하지 않고 노출", () => {
  const manifestDir = new URL("../packs/", import.meta.url);
  const manifests = fsMod.readdirSync(manifestDir)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => JSON.parse(fsMod.readFileSync(new URL(name, manifestDir), "utf8")));
  const catalogEntries = manifests.flatMap(manifest =>
    (manifest.catalog ?? []).map(entry => ({ manifest, entry })));
  const melodicEntries = catalogEntries.filter(({ entry }) => !entry.drum);
  const drumEntries = catalogEntries.filter(({ entry }) => entry.drum);
  assert.equal(Object.keys(SF_PRESETS).length, 71 + melodicEntries.length,
    "기존 멜로디 프리셋과 managed pack 전체 catalog 수가 맞지 않음");
  assert.equal(Object.keys(SF_DRUM_KITS).length, 6 + drumEntries.length,
    "기존 드럼 킷과 managed pack 전체 catalog 수가 맞지 않음");
  const catalogIds = new Set();
  let salamanderControlledPieces = 0;
  for (const { manifest, entry } of catalogEntries) {
    assert.ok(!catalogIds.has(entry.id), `managed catalog ID 중복: ${entry.id}`);
    catalogIds.add(entry.id);
    const spec = (entry.drum ? SF_DRUM_KITS : SF_PRESETS)[entry.id];
    assert.equal(spec?.engine, "sfizz", `${entry.id}가 sfizz sampler로 등록되지 않음`);
    assert.equal(spec?.pack, manifest.id, `${entry.id} pack 연결 불일치`);
    assert.equal(spec?.sfz, entry.path, `${entry.id} SFZ 경로 불일치`);
    assert.equal(spec?.kind, entry.kind ?? (entry.drum ? "drum-kit" : "instrument"), `${entry.id} kind 불일치`);
    if (entry.drum) {
      assert.deepEqual(spec?.pieces,
        Object.fromEntries((entry.pieces ?? []).map(piece => [piece.id, piece.key])),
        `${entry.id} piece map 불일치`);
      if (manifest.id === "salamander-drumkit-sfz") {
        const expectedControls = Object.fromEntries((entry.pieces ?? [])
          .filter(piece => Array.isArray(piece.cc) && piece.cc.length)
          .map(piece => [piece.id, piece.cc]));
        assert.deepEqual(spec?.pieceControls, expectedControls,
          `${entry.id} piece control map 불일치`);
        salamanderControlledPieces += Object.keys(expectedControls).length;
      }
    }
  }
  assert.ok(salamanderControlledPieces > 0,
    "Salamander manifest의 동일 키 피스를 구분할 CC control이 등록되지 않음");

  // 기존 GeneralUser ID는 저장곡 호환을 위해 그대로 두고, 화면 이름과 파일 핀으로 출처를 명시한다.
  for (const [id, preset] of Object.entries(SF_PRESETS)) {
    if (preset.font !== "default.sf2") continue;
    assert.match(preset.name, /\(GM\)/, `${id} 표시명에 GM 출처가 없음`);
  }

  const phil = {
    // [전용 파일, 내부 program, 표준 MIDI export program]
    "sf-violin-phil": ["philharmonia.sf2", 40, 40],
    "sf-viola-phil": ["philharmonia.sf2", 41, 41],
    "sf-cello-phil": ["philharmonia.sf2", 42, 42],
    "sf-contrabass-phil": ["philharmonia.sf2", 43, 43],
    "sf-violin-pizz-phil": ["philharmonia.sf2", 44, 45],
    "sf-viola-pizz-phil": ["philharmonia.sf2", 45, 45],
    "sf-contrabass-pizz-phil": ["philharmonia.sf2", 46, 32],
    "sf-violin-sord-phil": ["philharmonia.sf2", 48, 49],
    "sf-flute-phil": ["phil-winds.sf2", 73, 73],
    "sf-oboe-phil": ["phil-winds.sf2", 68, 68],
    "sf-english-horn-phil": ["phil-winds.sf2", 69, 69],
    "sf-clarinet-phil": ["phil-winds.sf2", 71, 71],
    "sf-bass-clarinet-phil": ["phil-winds.sf2", 72, 71],
    "sf-bassoon-phil": ["phil-winds.sf2", 70, 70],
    "sf-contrabassoon-phil": ["phil-winds.sf2", 74, 70],
    "sf-sax-phil": ["phil-winds.sf2", 65, 65],
    "sf-trumpet-phil": ["phil-brass.sf2", 56, 56],
    "sf-horn-phil": ["phil-brass.sf2", 60, 60],
    "sf-trombone-phil": ["phil-brass.sf2", 57, 57],
    "sf-tuba-phil": ["phil-brass.sf2", 58, 58]
  };
  assert.equal(Object.keys(phil).length, 20);
  for (const [id, [font, program, gm]] of Object.entries(phil)) {
    assert.equal(SF_PRESETS[id]?.font, font, `${id}가 ${font}에 명시적으로 고정되지 않음`);
    assert.equal(SF_PRESETS[id]?.program, program, `${id} 내부 SoundFont program 불일치`);
    assert.equal(SF_PRESETS[id]?.gm, gm, `${id} MIDI export program 불일치`);
    assert.match(SF_PRESETS[id]?.name ?? "", /\(Philharmonia\)/, `${id} 표시명에 출처가 없음`);
  }

  const families = [
    ["Grand Piano", "sf-piano-gm", "GM", "sf-piano", "Salamander"],
    ["Glockenspiel", "sf-glockenspiel-gm", "GM", "sf-glockenspiel", "VSCO"],
    ["Marimba", "sf-marimba-gm", "GM", "sf-marimba", "VSCO"],
    ["Xylophone", "sf-xylophone-gm", "GM", "sf-xylophone", "VSCO"],
    ["Orchestral Harp", "sf-harp-gm", "GM", "sf-harp", "VSCO"],
    ["Timpani", "sf-timpani-gm", "GM", "sf-timpani", "VSCO"],
    ["Violin", "sf-violin", "GM", "sf-violin-phil", "Philharmonia"],
    ["Viola", "sf-viola", "GM", "sf-viola-phil", "Philharmonia"],
    ["Cello", "sf-cello", "GM", "sf-cello-phil", "Philharmonia"],
    ["Double Bass", "sf-contrabass", "GM", "sf-contrabass-phil", "Philharmonia"],
    ["Violin Pizzicato", "sf-violin-pizz", "GM", "sf-violin-pizz-phil", "Philharmonia"],
    ["Viola Pizzicato", "sf-viola-pizz", "GM", "sf-viola-pizz-phil", "Philharmonia"],
    ["Double Bass Pizzicato", "sf-contrabass-pizz", "GM", "sf-contrabass-pizz-phil", "Philharmonia"],
    ["Violin Sordino", "sf-violin-sord", "GM", "sf-violin-sord-phil", "Philharmonia"],
    ["Flute", "sf-flute", "GM", "sf-flute-phil", "Philharmonia"],
    ["Oboe", "sf-oboe", "GM", "sf-oboe-phil", "Philharmonia"],
    ["English Horn", "sf-english-horn", "GM", "sf-english-horn-phil", "Philharmonia"],
    ["Clarinet", "sf-clarinet", "GM", "sf-clarinet-phil", "Philharmonia"],
    ["Bass Clarinet", "sf-bass-clarinet", "GM", "sf-bass-clarinet-phil", "Philharmonia"],
    ["Bassoon", "sf-bassoon", "GM", "sf-bassoon-phil", "Philharmonia"],
    ["Contrabassoon", "sf-contrabassoon", "GM", "sf-contrabassoon-phil", "Philharmonia"],
    ["Alto Sax", "sf-sax", "GM", "sf-sax-phil", "Philharmonia"],
    ["Trumpet", "sf-trumpet", "GM", "sf-trumpet-phil", "Philharmonia"],
    ["French Horn", "sf-horn", "GM", "sf-horn-phil", "Philharmonia"],
    ["Trombone", "sf-trombone", "GM", "sf-trombone-phil", "Philharmonia"],
    ["Tuba", "sf-tuba", "GM", "sf-tuba-phil", "Philharmonia"]
  ];
  for (const [family, a, sourceA, b, sourceB] of families) {
    assert.deepEqual([SF_PRESETS[a]?.family, SF_PRESETS[a]?.source], [family, sourceA], `${a} family/source 불일치`);
    assert.deepEqual([SF_PRESETS[b]?.family, SF_PRESETS[b]?.source], [family, sourceB], `${b} family/source 불일치`);
  }
  assert.deepEqual(
    { ...SF_DRUM_KITS["sf-orch-kit-phil"], pieces: undefined },
    {
      name: "Orchestral Percussion (Philharmonia)",
      desc: SF_DRUM_KITS["sf-orch-kit-phil"].desc,
      bank: 128, program: 0, release: 6.0, pieces: undefined,
      velRange: 0.9, font: "phil-perc.sf2",
      family: "Orchestral Percussion", source: "Philharmonia"
    }
  );
  assert.deepEqual(
    [SF_DRUM_KITS["sf-orch-kit"].family, SF_DRUM_KITS["sf-orch-kit"].source],
    ["Orchestral Percussion", "GM"]
  );
  assert.equal(SF_DRUM_KITS["sf-orch-kit-phil"].pieces, SF_DRUM_KITS["sf-orch-kit"].pieces,
    "Philharmonia 타악 피스 어휘가 기존 오케스트라 킷과 다름");

  // 기존 GeneralUser 매핑도 Philharmonia 추가 때문에 바뀌면 안 된다.
  assert.equal(SF_PRESETS["sf-violin-pizz"].gm, 45, "피치카토 대체음이 GM Pizzicato Strings가 아님");
  assert.equal(SF_PRESETS["sf-contrabass-pizz"].gm, 32, "저음 피치카토가 GM Acoustic Bass가 아님");
  assert.equal(SF_PRESETS["sf-violin-sord"].gm, 49, "약음기 대체음이 GM Slow Strings가 아님");
  assert.equal(SF_PRESETS["sf-bass-clarinet"].gm, 71, "베이스 클라리넷 대체음이 GM Piccolo로 잘못 바뀜");
  assert.equal(SF_PRESETS["sf-contrabassoon"].gm, 70, "콘트라바순 대체음이 GM Recorder로 잘못 바뀜");
});

ok("큰 음원 카탈로그는 요약하고 악기군·주법으로 좁혀 찾음", () => {
  const summary = ops.list_presets();
  const totalPresets = Object.keys(SF_PRESETS).length + Object.keys(SF_DRUM_KITS).length;
  assert.ok(summary.includes(`외부 샘플 프리셋 ${totalPresets}개`));
  assert.match(summary, /list_presets\(\{family:"Violin"\}\)/);
  assert.ok(!summary.includes("vsco-solo-violin-vibrato"), "요약이 모든 preset ID를 쏟아 문맥을 낭비함");
  const violin = ops.list_presets({ family: "Violin" });
  assert.match(violin, /sf-violin-phil/);
  assert.match(violin, /vsco-solo-violin-vibrato/);
  const doubleBass = ops.list_presets({ family: "Double Bass", limit: 100 });
  assert.match(doubleBass, /검색 결과 90개 중 90개 표시/);
  assert.match(doubleBass, /sf-contrabass-phil/);
  assert.match(doubleBass, /vsco-contrabass-keyswitch/);
  assert.match(ops.list_presets({ family: "Contrabass" }), /조건에 맞는 샘플 프리셋이 없습니다/);
  const tremolo = ops.list_presets({ query: "tremolo", source: "VSCO 2 CE" });
  assert.match(tremolo, /vsco-violin-ensemble-tremolo/);
  assert.ok(!tremolo.includes("sf-piano-gm"));

  const broad = ops.list_presets({ source: "Philharmonia", limit: 5 });
  assert.match(broad, /중 5개 표시/);
  assert.match(broad, /더 있습니다 .*query·family·source·kind/);
  assert.ok(broad.split("\n").length < 30, "넓은 검색이 MCP 문맥에 catalog 전체를 쏟음");
  const clips = ops.list_presets({ source: "Philharmonia", kind: "clip", limit: 2 });
  assert.match(clips, /\[clip ·/);
  assert.match(clips, /Recorded Clip|녹음 클립/);
  assert.throws(() => ops.list_presets({ limit: 101 }), /1~100/);
});

ok("키스위치 프리셋의 원래 연주법을 곡·도구가 검증하고 보존", () => {
  const [presetId, preset] = Object.entries(SF_PRESETS).find(([, item]) =>
    item.articulations && Object.keys(item.articulations).length > 1);
  assert.ok(presetId, "선택 가능한 키스위치 프리셋이 없음");
  const choices = Object.keys(preset.articulations);
  const source = {
    title: "articulation", bpm: 100, timeSig: [4, 4], tempoMap: [],
    tracks: [{
      name: "주법 악기", preset: presetId, articulation: choices[0], volume: 0.8, pan: 0,
      notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 }]
    }]
  };
  const validated = validateSong(source);
  assert.equal(validated.tracks[0].articulation, choices[0]);
  assert.throws(() => validateSong({
    ...source, tracks: [{ ...source.tracks[0], articulation: "없는-연주법" }]
  }), /articulation.*찾을 수 없습니다/);
  state.song = validated;
  ops.set_track({ track: "주법 악기", articulation: choices[1] });
  assert.equal(state.song.tracks[0].articulation, choices[1]);
  ops.set_track({ track: "주법 악기", articulation: null });
  assert.equal(state.song.tracks[0].articulation, undefined);
  assert.throws(() => ops.set_track({ track: "주법 악기", articulation: "없는-연주법" }), /list_presets/);
  const listed = ops.list_presets({ query: `${preset.family} ${choices[0]}`, limit: 5 });
  assert.match(listed, new RegExp(presetId));
  assert.match(listed, /articulation:/);
});

ok("구간 주법이 겹친 범위를 나눠 대체하고 선택 범위만 상속값으로 되돌림", () => {
  const [presetId, preset] = Object.entries(SF_PRESETS).find(([, item]) =>
    item.articulations && Object.keys(item.articulations).length > 1);
  const [sustain, contrast] = Object.keys(preset.articulations);
  const make = articulationRegions => validateSong({
    title: "regional articulation", bpm: 100, timeSig: [4, 4], tempoMap: [],
    tracks: [{
      name: "구간 주법 악기", preset: presetId, articulation: sustain,
      articulationRegions, volume: 0.8, pan: 0,
      notes: [1, 3, 4, 5, 6, 8].map(bar => ({ bar, beat: 0, pitch: "C4", dur: 1, vel: 90 }))
    }]
  });

  const canonical = make([
    { from: 3, to: 4, articulation: contrast },
    { from: 1, to: 2, articulation: contrast }
  ]);
  assert.deepEqual(canonical.tracks[0].articulationRegions,
    [{ from: 1, to: 4, articulation: contrast }], "인접한 같은 주법이 합쳐지지 않음");
  assert.equal(effectiveArticulation(canonical.tracks[0], 2), contrast);
  assert.equal(effectiveArticulation(canonical.tracks[0], 8), sustain);
  assert.throws(() => make([
    { from: 1, to: 3, articulation: sustain },
    { from: 3, to: 4, articulation: contrast }
  ]), /겹칩니다/);
  assert.throws(() => make([{ from: 1, to: 2, articulation: "없는-연주법" }]),
    /구간 articulation.*찾을 수 없습니다/);
  assert.throws(() => validateSong({
    title: "unsupported regional articulation", bpm: 100, timeSig: [4, 4], tempoMap: [],
    tracks: [{ name: "GM", preset: "sf-piano-gm", volume: 0.8, pan: 0,
      articulationRegions: [{ from: 1, to: 2, articulation: sustain }], notes: [] }]
  }), /별도 연주법 선택 없음/);

  state.song = make([]);
  ops.set_region_articulation({
    track: "구간 주법 악기", from_bar: 2, to_bar: 7, articulation: sustain
  });
  ops.set_region_articulation({
    track: "구간 주법 악기", from_bar: 4, to_bar: 5, articulation: contrast
  });
  assert.deepEqual(state.song.tracks[0].articulationRegions, [
    { from: 2, to: 3, articulation: sustain },
    { from: 4, to: 5, articulation: contrast },
    { from: 6, to: 7, articulation: sustain }
  ]);
  ops.set_region_articulation({
    track: "구간 주법 악기", from_bar: 5, to_bar: 6, articulation: null
  });
  assert.deepEqual(state.song.tracks[0].articulationRegions, [
    { from: 2, to: 3, articulation: sustain },
    { from: 4, to: 4, articulation: contrast },
    { from: 7, to: 7, articulation: sustain }
  ], "null이 선택 범위 밖 override까지 지움");
  assert.throws(() => ops.set_region_articulation({
    track: "구간 주법 악기", from_bar: 1, to_bar: 2, articulation: "없는-연주법"
  }), /list_presets/);

  const before = JSON.stringify(state.song);
  runOp("set_region_articulation", {
    track: "구간 주법 악기", from_bar: 8, to_bar: 8, articulation: contrast
  }, "gui");
  assert.equal(effectiveArticulation(state.song.tracks[0], 8), contrast);
  runOp("undo_edit", {}, "gui");
  assert.equal(JSON.stringify(state.song), before, "구간 주법 한 번이 undo 한 단계로 복원되지 않음");
  runOp("redo_edit", {}, "gui");
  assert.equal(effectiveArticulation(state.song.tracks[0], 8), contrast);

  const regionsBeforeRepeatedPreset = structuredClone(state.song.tracks[0].articulationRegions);
  ops.set_track({ track: "구간 주법 악기", preset: presetId, volume: 0.9 });
  assert.equal(state.song.tracks[0].articulation, sustain,
    "같은 preset ID를 반복한 설정이 트랙 전체 주법을 지움");
  assert.deepEqual(state.song.tracks[0].articulationRegions, regionsBeforeRepeatedPreset,
    "같은 preset ID를 반복한 설정이 구간 주법을 지움");

  ops.set_track({ track: "구간 주법 악기", preset: "sf-piano-gm" });
  assert.equal(state.song.tracks[0].articulation, undefined);
  assert.equal(state.song.tracks[0].articulationRegions, undefined,
    "프리셋 변경 뒤 옛 ID namespace의 구간 주법이 남음");
});

ok("마디 삽입·복제·잘라내기가 구간 주법의 의미를 함께 보존", () => {
  const [presetId, preset] = Object.entries(SF_PRESETS).find(([, item]) =>
    item.articulations && Object.keys(item.articulations).length > 1);
  const [a, b] = Object.keys(preset.articulations);
  const make = regions => validateSong({
    title: "regional articulation structure", bpm: 100, timeSig: [4, 4], tempoMap: [],
    tracks: [{ name: "현악", preset: presetId, volume: 0.8, pan: 0,
      articulationRegions: regions,
      notes: Array.from({ length: 12 }, (_, i) => ({ bar: i + 1, beat: 0, pitch: "C4", dur: 1, vel: 90 })) }]
  });

  state.song = make([{ from: 2, to: 4, articulation: a }]);
  ops.insert_bars({ at_bar: 3, count: 2 });
  assert.deepEqual(state.song.tracks[0].articulationRegions,
    [{ from: 2, to: 6, articulation: a }], "구간 안 삽입이 주법 범위를 늘리지 않음");

  state.song = make([
    { from: 1, to: 2, articulation: a },
    { from: 4, to: 4, articulation: b },
    { from: 5, to: 8, articulation: b }
  ]);
  ops.copy_bars({ from_bar: 1, to_bar: 4, at_bar: 5, mode: "overwrite" });
  assert.deepEqual(state.song.tracks[0].articulationRegions, [
    { from: 1, to: 2, articulation: a },
    { from: 4, to: 4, articulation: b },
    { from: 5, to: 6, articulation: a },
    { from: 8, to: 8, articulation: b }
  ], "overwrite 복제가 source의 상속 빈칸까지 대상 범위에 복제하지 않음");

  state.song = make([
    { from: 1, to: 3, articulation: a },
    { from: 4, to: 6, articulation: b },
    { from: 7, to: 8, articulation: a }
  ]);
  ops.delete_bars({ from_bar: 3, to_bar: 6 });
  assert.deepEqual(state.song.tracks[0].articulationRegions,
    [{ from: 1, to: 4, articulation: a }], "잘라내기 뒤 맞닿은 같은 주법이 이어지지 않음");
});

ok("SFZ Instrument·구간 Articulation·Velocity 편집이 attack sample 누락을 원자적으로 거부", () => {
  const presetId = "test-sfz-attack-coverage";
  const fixtureDir = path.join(soundfonts.dataDir, "sfz-attack-coverage");
  const sfz = path.join(fixtureDir, "SViolin-KS.sfz");
  const missingPresetId = "test-sfz-missing-first";
  const badPresetId = "test-sfz-invalid-metadata";
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "sample.wav"), Buffer.from([1]));
  const validSfzText = [
    "<control> default_path=./",
    "<global> sw_default=36 sw_lokey=36 sw_hikey=37",
    "<group> sw_last=36",
    "<region> sample=sample.wav key=60 hivel=100",
    "<group> sw_last=37",
    "<region> sample=sample.wav key=61"
  ].join("\n");
  fs.writeFileSync(sfz, validSfzText);
  SF_PRESETS[presetId] = {
    engine: "sfizz", sfz, name: "Solo Violin · Keyswitch Test", family: "Violin", source: "Test",
    gm: 40, gain: 1, reverb: 0.3, release: 0.5,
    articulations: {
      sustain: {
        label: "Sustain Vibrato (길게 이어 연주하며 음높이를 부드럽게 떨기)",
        keyswitch: { key: 36, velocity: 127 }
      },
      staccato: {
        label: "Staccato (활을 짧게 써 또렷하게 끊어 연주)",
        keyswitch: { key: 37, velocity: 127 }
      }
    },
    defaultArticulation: "sustain"
  };
  SF_PRESETS[missingPresetId] = {
    ...SF_PRESETS[presetId], sfz:path.join(fixtureDir, "not-installed.sfz"),
    name:"Missing SFZ Test"
  };
  SF_PRESETS[badPresetId] = {
    ...SF_PRESETS[presetId], name:"Invalid Metadata Test",
    articulations:{ bad:{ label:"Bad Articulation", keyswitch:{ key:999, velocity:127 } } },
    defaultArticulation:"bad"
  };

  try {
    state.song = validateSong({
      title:"instrument preflight", bpm:120, timeSig:[4, 4], tempoMap:[],
      tracks:[{ name:"바이올린", preset:"sf-violin", volume:0.8, pan:0,
        notes:[{ bar:94, beat:3.75, pitch:"E3", dur:0.25, vel:83 }] }]
    });
    let before = JSON.stringify(state.song);
    let historyBefore = ops.edit_history();
    assert.throws(() => runOp("set_track", {
      track:"바이올린", preset:presetId, articulation:"sustain", velRange:1
    }, "gui"), error => {
      assert.equal(error.code, "SAMPLE_MISSING");
      assert.equal(error.attackCoverageMismatch, true);
      assert.equal(error.track, "바이올린");
      assert.equal(error.bar, 94);
      assert.equal(error.beat, 3.75);
      assert.equal(error.pitch, "E3");
      assert.equal(error.midi, 52);
      assert.equal(error.velocity, 83);
      assert.match(error.message, /94마디 3\.75박/);
      assert.match(error.message, /Pitch \(피치, 음높이\) E3 \(MIDI 52\)/);
      assert.match(error.message, /Velocity \(벨로시티/);
      assert.match(error.message, /Articulation \(아티큘레이션/);
      assert.match(error.message, /Attack Region \(어택 리전/);
      assert.match(error.message, /저장하지 않았습니다/);
      return true;
    });
    assert.equal(JSON.stringify(state.song), before, "거부한 Instrument 변경이 곡을 일부 변경함");
    assert.equal(ops.edit_history(), historyBefore, "거부한 Instrument 변경이 undo 이력을 추가함");

    state.song = validateSong({
      title:"articulation preflight", bpm:120, timeSig:[4, 4], tempoMap:[],
      tracks:[{ name:"바이올린", preset:"sf-violin", volume:0.8, pan:0,
        notes:[{ bar:1, beat:0, pitch:"C4", dur:1, vel:80 }] }]
    });
    runOp("set_track", {
      track:"바이올린", preset:presetId, articulation:"sustain", velRange:1
    }, "gui");
    before = JSON.stringify(state.song);
    historyBefore = ops.edit_history();
    assert.throws(() => runOp("set_region_articulation", {
      track:"바이올린", from_bar:1, to_bar:1, articulation:"staccato"
    }, "gui"), /1마디 0박.*C4.*Staccato.*Attack Region/);
    assert.equal(JSON.stringify(state.song), before, "거부한 구간 Articulation이 곡을 일부 변경함");
    assert.equal(ops.edit_history(), historyBefore, "거부한 구간 Articulation이 undo 이력을 추가함");

    assert.throws(() => runOp("set_velocity", {
      track:"바이올린", from_bar:1, to_bar:1, vel:110
    }, "gui"), /Velocity .*110.*Attack Region/);
    assert.equal(JSON.stringify(state.song), before, "거부한 Velocity 변경이 곡을 일부 변경함");
    assert.equal(ops.edit_history(), historyBefore, "거부한 Velocity 변경이 undo 이력을 추가함");

    // 예전 저장곡에 누락 음이 여러 개 있어도 그대로 열리고, coverage와 무관한 편집 및
    // 한 음씩의 부분 수리는 허용한다. 남은 옛 누락이 새 결함으로 오판되면 안 된다.
    const legacy = validateSong({
      title:"legacy sfz invalid", bpm:120, timeSig:[4, 4], tempoMap:[],
      tracks:[{ name:"옛 바이올린", preset:presetId, articulation:"sustain",
        volume:0.8, pan:0, velRange:1, notes:[
          { bar:1, beat:0, pitch:"E3", dur:1, vel:80 },
          { bar:2, beat:0, pitch:"F3", dur:1, vel:80 }
        ] }]
    });
    state.song = legacy;
    let savedSongs = null;
    const unsubscribeSave = subscribe(event => {
      if (event.type === "state") savedSongs = event.songs;
    });
    try {
      assert.match(ops.save_song({ name:"legacy sfz invalid saved" }), /보관/,
        "save_song이 불필요한 mutated 뒤 실패함");
    } finally { unsubscribeSave(); }
    assert.ok(savedSongs?.includes("legacy sfz invalid saved"),
      "coverage/autosave를 생략한 save_song이 GUI 곡 목록 broadcast까지 잃음");
    state.song = validateSong({ title:"before legacy load", bpm:120, timeSig:[4,4], tempoMap:[],
      tracks:[{ name:"Piano", preset:"sf-piano-gm", volume:0.8, pan:0,
        notes:[{ bar:1, beat:0, pitch:"C4", dur:1, vel:80 }] }] });
    runOp("load_song", { name:"legacy sfz invalid saved" }, "gui");
    runOp("set_track", { track:"옛 바이올린", new_name:"옛 바이올린 수정", volume:0.7 }, "gui");
    runOp("add_feedback", { from_bar:1, text:"legacy 곡을 고치는 중" }, "gui");
    runOp("delete_note", { track:"옛 바이올린 수정", bar:1, beat:0, pitch:"E3", dur:1 }, "gui");
    assert.deepEqual(state.song.tracks[0].notes.map(note => note.pitch), ["F3"],
      "첫 누락을 고칠 때 두 번째 legacy 누락 때문에 수리가 막힘");
    before = JSON.stringify(state.song);
    historyBefore = ops.edit_history();
    assert.throws(() => runOp("add_notes", { track:"옛 바이올린 수정", notes:[
      { bar:3, beat:0, pitch:"D3", dur:1, vel:80 }
    ] }, "gui"), /D3.*Attack Region/);
    assert.equal(JSON.stringify(state.song), before, "새 누락 음 거부가 legacy 곡을 오염시킴");
    assert.equal(ops.edit_history(), historyBefore, "새 누락 음 거부가 history를 오염시킴");

    // autosave와 A/B load도 같은 legacy-adopt 정책을 쓴다.
    fs.writeFileSync(path.join(soundfonts.dataDir, "song.json"), JSON.stringify(legacy));
    assert.equal(loadAutosave(), true);
    runOp("set_track", { track:"옛 바이올린", volume:0.65 }, "gui");
    state.song = legacy;
    ops.ab_save({ slot:"A" });
    state.song = validateSong({ title:"before ab", bpm:120, timeSig:[4,4], tempoMap:[], tracks:[] });
    runOp("ab_load", { slot:"A" }, "gui");
    runOp("set_track", { track:"옛 바이올린", volume:0.6 }, "gui");

    // 첫 SFZ track의 asset 부재는 그 track만 건너뛰고, 뒤 track의 실제 mismatch를 찾는다.
    const masked = validateSong({
      title:"asset masking", bpm:120, timeSig:[4,4], tempoMap:[], tracks:[
        { name:"미설치", preset:missingPresetId, articulation:"sustain", volume:0.8, pan:0,
          notes:[{ bar:1, beat:0, pitch:"C4", dur:1, vel:80 }] },
        { name:"검사 대상", preset:presetId, articulation:"sustain", velRange:1, volume:0.8, pan:0,
          notes:[{ bar:1, beat:0, pitch:"C4", dur:1, vel:80 }] }
      ]
    });
    state.song = masked;
    ops.save_song({ name:"asset masking saved" });
    state.song = validateSong({ title:"before masking", bpm:120, timeSig:[4,4], tempoMap:[], tracks:[] });
    runOp("load_song", { name:"asset masking saved" }, "gui");
    before = JSON.stringify(state.song);
    historyBefore = ops.edit_history();
    assert.throws(() => runOp("set_velocity", {
      track:"검사 대상", from_bar:1, to_bar:1, vel:110
    }, "gui"), /검사 대상.*Velocity .*110.*Attack Region/);
    assert.equal(JSON.stringify(state.song), before, "앞 미설치 asset이 뒤 mismatch 원자성을 깨뜨림");
    assert.equal(ops.edit_history(), historyBefore, "앞 미설치 asset이 뒤 mismatch history를 깨뜨림");

    // engine 오류 전체를 삼키지 않는다. asset-unavailable이 아닌 metadata 결함은 그대로 실패한다.
    state.song = validateSong({ title:"bad metadata source", bpm:120, timeSig:[4,4], tempoMap:[],
      tracks:[{ name:"바이올린", preset:"sf-violin", volume:0.8, pan:0,
        notes:[{ bar:1, beat:0, pitch:"C4", dur:1, vel:80 }] }] });
    before = JSON.stringify(state.song);
    assert.throws(() => runOp("set_track", {
      track:"바이올린", preset:badPresetId, articulation:"bad"
    }, "gui"), /keyswitch.*0~127|0~127.*keyswitch/i);
    assert.equal(JSON.stringify(state.song), before, "비-asset SFZ 오류가 삼켜져 preset이 반영됨");

    // redo snapshot은 저장 당시 유효했지만 SFZ asset이 바뀌면 이제 무음일 수 있다.
    // candidate 검사 전에 stack을 pop하면 실패한 redo가 history까지 망가진다.
    fs.writeFileSync(sfz, validSfzText);
    state.song = validateSong({ title:"history asset epoch", bpm:120, timeSig:[4,4], tempoMap:[],
      tracks:[{ name:"바이올린", preset:"sf-violin", volume:0.8, pan:0,
        notes:[{ bar:1, beat:0, pitch:"C4", dur:1, vel:80 }] }] });
    runOp("set_track", {
      track:"바이올린", preset:presetId, articulation:"sustain", velRange:1
    }, "gui");
    runOp("undo_edit", {}, "gui");
    fs.writeFileSync(sfz, validSfzText.replace("key=60", "key=62"));
    before = JSON.stringify(state.song);
    historyBefore = ops.edit_history();
    assert.throws(() => runOp("redo_edit", {}, "gui"), /C4.*Attack Region/);
    assert.equal(JSON.stringify(state.song), before, "실패한 redo가 state를 바꿈");
    assert.equal(ops.edit_history(), historyBefore, "실패한 redo가 undo/redo stack을 바꿈");
    fs.writeFileSync(sfz, validSfzText);
  } finally {
    fs.writeFileSync(sfz, validSfzText);
    delete SF_PRESETS[presetId];
    delete SF_PRESETS[missingPresetId];
    delete SF_PRESETS[badPresetId];
  }
});

ok("SFZ Pitch Bend 편집은 실제 주법별 MIDI 채널 한도를 원자적으로 지킨다", () => {
  const [presetId, preset] = Object.entries(SF_PRESETS).find(([, item]) =>
    item.engine === "sfizz" && item.articulations && Object.keys(item.articulations).length > 1);
  assert.ok(presetId, "여러 주법이 있는 SFZ 프리셋이 없음");
  const defaultArticulation = preset.defaultArticulation ?? Object.keys(preset.articulations)[0];
  const make = (notes, regions = undefined) => validateSong({
    title:"sfizz bend capacity", bpm:120, timeSig:[4, 4], tempoMap:[],
    tracks:[{ name:"SFZ 현악", preset:presetId, volume:0.8, pan:0,
      ...(regions ? { articulationRegions:regions } : {}), notes }]
  });
  const id = note => ({ bar:note.bar, beat:note.beat, pitch:note.pitch, dur:note.dur });
  const acrossBars = Array.from({ length:17 }, (_, index) => ({
    bar:index + 1, beat:0, pitch:"C4", dur:0.5, vel:90
  }));

  state.song = make(acrossBars);
  const before = JSON.stringify(state.song);
  const historyBefore = ops.edit_history();
  assert.throws(() => runOp("set_bend", {
    track:"SFZ 현악", notes:acrossBars.map(id), bend:2
  }, "gui"), /MIDI 채널 17개.*SFZ 한도 16개/);
  assert.equal(JSON.stringify(state.song), before, "거부한 Pitch Bend가 곡을 일부 변경함");
  assert.equal(ops.edit_history(), historyBefore, "거부한 Pitch Bend가 undo 이력을 추가함");

  state.song = make(acrossBars);
  assert.throws(() => ops.set_bend({
    track:"SFZ 현악", notes:acrossBars.slice(0, 16).map(id), bend:-2
  }), /MIDI 채널 17개/, "16개 bend와 straight lane 하나를 16채널로 잘못 셈");
  ops.set_bend({ track:"SFZ 현악", notes:acrossBars.slice(0, 15).map(id), bend:2 });
  assert.equal(state.song.tracks[0].notes.filter(note => note.bend === 2).length, 15,
    "15개 bend + 재사용 가능한 straight lane을 허용하지 않음");
  const beforePaste = JSON.stringify(state.song);
  const pasteHistoryBefore = ops.edit_history();
  assert.throws(() => runOp("add_notes", { track:"SFZ 현악", notes:[
    { bar:18, beat:0, pitch:"C4", dur:0.5, vel:90, bend:2 }
  ] }, "gui"), /MIDI 채널 17개/, "bend를 보존한 붙여넣기가 SFZ 채널 검사를 우회함");
  assert.equal(JSON.stringify(state.song), beforePaste, "거부한 bent note 붙여넣기가 곡을 일부 변경함");
  assert.equal(ops.edit_history(), pasteHistoryBefore, "거부한 bent note 붙여넣기가 undo 이력을 추가함");
  ops.set_bend({ track:"SFZ 현악", notes:acrossBars.map(id), bend:0 });
  assert.ok(state.song.tracks[0].notes.every(note => note.bend === undefined),
    "Pitch Bend 0으로 채널 용량을 복구하지 못함");

  const firstLayer = Array.from({ length:8 }, (_, index) => ({
    bar:1, beat:index * 0.4, pitch:"C4", dur:0.2, vel:90
  }));
  const explicitDefaultLayer = Array.from({ length:9 }, (_, index) => ({
    bar:2, beat:index * 0.4, pitch:"C4", dur:0.2, vel:90
  }));
  const split = [...firstLayer, ...explicitDefaultLayer];
  state.song = make(split, [{ from:2, to:2, articulation:defaultArticulation }]);
  ops.set_bend({ track:"SFZ 현악", notes:split.map(id), bend:-12 });
  assert.equal(state.song.tracks[0].notes.filter(note => note.bend === -12).length, 17,
    "implicit 기본과 explicit 주법의 독립 렌더 층을 합쳐 거짓 거부함");
  const beforeMerge = JSON.stringify(state.song);
  assert.throws(() => runOp("set_region_articulation", {
    track:"SFZ 현악", from_bar:2, to_bar:2, articulation:null
  }, "gui"), /MIDI 채널 17개/, "구간 주법 병합이 SFZ 채널 검사를 우회함");
  assert.equal(JSON.stringify(state.song), beforeMerge, "거부한 주법 층 병합이 곡을 일부 변경함");
});

ok("SFZ one-shot은 피스별 실측 길이를 갖고 일반 악기는 원본 파일 길이를 release로 쓰지 않음", () => {
  const catalogKits = Object.entries(SF_DRUM_KITS).filter(([, preset]) => preset.engine === "sfizz");
  assert.ok(catalogKits.length > 0, "SFZ 타악/클립 카탈로그가 없음");
  for (const [id, preset] of catalogKits) {
    assert.deepEqual(Object.keys(preset.pieceDurationsSec).sort(), Object.keys(preset.pieces).sort(),
      `${id}: 일부 피스의 실측 sample 길이가 없음`);
    for (const [piece, durationSec] of Object.entries(preset.pieceDurationsSec))
      assert.ok(Number.isFinite(durationSec) && durationSec > 0, `${id}/${piece}: 잘못된 피스 길이`);
    assert.equal(preset.tailHintSec, 0.5, `${id}: tailHint는 원본 뒤의 짧은 guard여야 함`);
    assert.equal(preset.release, 0.3, `${id}: one-shot release에 원본 전체 길이가 들어가면 안 됨`);
  }
  for (const [id, preset] of Object.entries(SF_PRESETS).filter(([, item]) => item.engine === "sfizz")) {
    assert.equal(preset.durationSec, null, `${id}: 일반 pitched 악기가 원본 파일 길이를 one-shot 길이로 상속함`);
    assert.ok(Number.isFinite(preset.release) && preset.release >= 0, `${id}: 실제 noteOff release가 없음`);
  }
});

ok("녹음 클립은 짧은 trigger 노트여도 원본 재생 길이까지 곡 길이에 반영", () => {
  const [clipId, clipPreset] = Object.entries(SF_DRUM_KITS)
    .filter(([, preset]) => preset.kind === "clip" && Number.isFinite(preset.durationSec))
    .sort((a, b) => b[1].durationSec - a[1].durationSec)[0];
  assert.ok(clipId && clipPreset.durationSec > 1, "길이가 기록된 녹음 클립이 없음");
  const clipSong = validateSong({
    title: "recorded clip timeline", bpm: 120, timeSig: [4, 4], tempoMap: [],
    tracks: [{
      name: "Recorded Clip", preset: clipId, volume: 1, pan: 0,
      notes: [{ bar: 8, beat: 0, pitch: Object.keys(clipPreset.pieces)[0], dur: 0.5, vel: 100 }]
    }]
  });
  const expected = Math.ceil(((8 - 1) * 4 + clipPreset.durationSec * 2) / 4);
  assert.equal(totalBars(clipSong), Math.max(8, expected));

  const slowClipSong = validateSong({
    ...clipSong,
    tempoMap: [{ bar: 8, bpm: 60 }]
  });
  const expectedAt60 = Math.ceil(((8 - 1) * 4 + clipPreset.durationSec) / 4);
  assert.equal(totalBars(slowClipSong), Math.max(8, expectedAt60),
    "클립이 시작되는 구간의 tempo를 반영해 초 단위 원본 길이를 마디 수로 바꿔야 함");
});

ok("녹음 클립 중간의 구조 편집·구간 재생을 무음이나 거짓 편집으로 처리하지 않음", () => {
  const [clipId, clipPreset] = Object.entries(SF_DRUM_KITS)
    .filter(([, preset]) => preset.kind === "clip" && Number.isFinite(preset.durationSec))
    .sort((a, b) => b[1].durationSec - a[1].durationSec)[0];
  assert.ok(clipId && clipPreset.durationSec > 20, "여러 마디에 걸친 회귀 테스트용 녹음 클립이 없음");
  const makeClipSong = () => validateSong({
    title: "fixed clip edit guard", bpm: 120, timeSig: [4, 4], tempoMap: [],
    tracks: [{
      name: "Long Recorded Clip", preset: clipId, volume: 1, pan: 0,
      notes: [{ bar: 1, beat: 0, pitch: Object.keys(clipPreset.pieces)[0], dur: 0.5, vel: 100 }]
    }]
  });

  state.song = makeClipSong();
  const before = JSON.stringify(state.song);
  assert.throws(() => ops.insert_bars({ at_bar: 2, count: 2 }), /Recorded Clip.*삽입 지점/);
  assert.equal(JSON.stringify(state.song), before, "거부한 insert_bars가 곡을 일부 변경함");
  assert.throws(() => ops.copy_bars({ from_bar: 1, to_bar: 1, at_bar: 2, mode: "insert" }),
    /Recorded Clip.*삽입 지점/);
  assert.equal(JSON.stringify(state.song), before, "거부한 copy_bars insert가 곡을 일부 변경함");
  assert.throws(() => ops.delete_bars({ from_bar: 2, to_bar: 10 }), /일부만 가릅니다/);
  assert.throws(() => ops.delete_bars({ from_bar: 1, to_bar: 1 }), /일부만 가릅니다/,
    "trigger만 포함하고 원본 꼬리를 남기는 삭제를 허용함");
  assert.equal(JSON.stringify(state.song), before, "거부한 delete_bars가 곡을 일부 변경함");

  assert.throws(() => renderRange(state.song, 2, 2, { sampleRate: 8000, tail: 0 }), error =>
    error.code === "CAPABILITY_UNSUPPORTED" && error.clipTriggerBar === 1 && /from_bar를 1 이하/.test(error.message));

  state.song = makeClipSong();
  const wholeSpan = totalBars(state.song);
  ops.delete_bars({ from_bar: 1, to_bar: wholeSpan });
  assert.equal(state.song.tracks[0].notes.length, 0, "전체 clip 구간을 포함한 삭제까지 거부함");
});

ok("GM 피아노와 Salamander 피아노를 별도 선택하고 MIDI 기본값은 GM을 사용", () => {
  assert.equal(SF_PRESETS["sf-piano-gm"].font, "default.sf2");
  assert.equal(SF_PRESETS["sf-piano"].font, "salamander.sf2");
  assert.equal(guessPreset(0), "sf-piano-gm");
});

ok("MIDI 가져오기가 선택형 VSCO 대신 같은 번호의 기본 GM 악기를 사용", () => {
  for (const [gm, id] of [[9, "sf-glockenspiel-gm"], [12, "sf-marimba-gm"],
    [13, "sf-xylophone-gm"], [46, "sf-harp-gm"], [47, "sf-timpani-gm"]]) {
    assert.equal(guessPreset(gm), id);
    assert.equal(SF_PRESETS[id].font, "default.sf2");
  }
});

ok("Philharmonia 내부 program과 표준 MIDI export program을 분리", () => {
  for (const [preset, internalProgram, midiProgram] of [
    ["sf-violin-pizz-phil", 44, 45],
    ["sf-contrabass-pizz-phil", 46, 32],
    ["sf-violin-sord-phil", 48, 49],
    ["sf-bass-clarinet-phil", 72, 71],
    ["sf-contrabassoon-phil", 74, 70]
  ]) {
    assert.equal(SF_PRESETS[preset].program, internalProgram);
    assert.equal(SF_PRESETS[preset].gm, midiProgram);
    const s = createSong({});
    s.tracks = [{ name: "ProgramTest", preset, volume: 0.8, pan: 0,
      notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 }] }];
    const buf = midiBuffer(validateSong(s));
    assert.ok(buf.includes(Buffer.from([0xc0, midiProgram])),
      `${preset}가 MIDI program ${midiProgram}으로 내보내지지 않음`);
    assert.ok(!buf.includes(Buffer.from([0xc0, internalProgram])),
      `${preset}가 전용 SoundFont 내부 program ${internalProgram}을 표준 MIDI로 노출함`);
  }
});

if (!sf2Available()) {
  console.log(`  (건너뜀) 사운드폰트 없음 — ${SF2_PATH}`);
} else {
  ok("가벼운 SoundFont 색인이 기본 프리셋을 설치됨으로 확인", () => {
    const status = fontStatus({ font: "default.sf2", bank: 0, program: 0 });
    assert.equal(status.available, true, status.reason);
    assert.equal(status.state, "installed");
  });

  ok("Philharmonia가 MIDI 근사값이 아닌 전용 내부 program으로 렌더됨", () => {
    const s = createSong({});
    s.tracks = [{ name: "Phil", preset: "sf-violin-pizz-phil", volume: 0.8, pan: 0,
      notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 100 }] }];
    const r = renderRange(validateSong(s), 1, 1, { tail: 0.2 });
    assert.ok(peakOf(r.left) > 0.005, "Philharmonia 전용 program 렌더가 무음");
    assert.ok(r.diagnostics.every(d => d.engine === "spessa-sf2"), "외부 SF2 엔진을 거치지 않음");
  });

  ok("모든 sf 멜로디 프리셋이 자기 음역에서 소리를 냄", () => {
    // C4 하나로만 재면 안 된다 — 콘트라베이스에 C4는 실제 악기 음역 밖이라 샘플이 없다.
    // (37개 중 24개가 어느 옥타브에선가 무음이다. 악기가 원래 그런 것이고, 여기서 볼 것은
    //  "이 프리셋이 자기 음역 어딘가에서는 제대로 소리를 내는가"다)
    for (const [pid, preset] of Object.entries(SF_PRESETS)) {
      // 전체 VSCO SFZ pack은 sfizz adapter/renderer 전용 테스트에서 75/75 검증한다.
      // 이 블록의 tiny fixture는 SoundFont backend만 검사한다.
      if (preset.engine === "sfizz") continue;
      let best = 0, bad = 0, renderedPitches = 0;
      for (const pitch of ["C2", "C3", "C4", "C5"]) {
        const s = createSong({});
        s.tracks = [{ name: "t", preset: pid, volume: 0.8, pan: 0,
          notes: [{ bar: 1, beat: 0, pitch, dur: 1, vel: 100 }] }];
        let r;
        try { r = renderRange(validateSong(s), 1, 1, { tail: 0.5 }); }
        catch (e) {
          // 실제 악기 음역 밖은 이제 무음으로 숨기지 않고 명시적으로 실패한다.
          assert.match(e.message, /샘플이 없습니다/, `${pid}/${pitch}: 예상 밖 오류 ${e.message}`);
          continue;
        }
        renderedPitches++;
        for (let i = 0; i < r.left.length; i++) {
          if (!Number.isFinite(r.left[i])) bad++;
          best = Math.max(best, Math.abs(r.left[i]));
        }
      }
      assert.equal(bad, 0, `${pid} NaN`);
      assert.ok(renderedPitches > 0, `${pid} C2~C5 전 음역에 대응 샘플이 없음`);
      assert.ok(best > 0.01, `${pid} C2~C5 어디서도 무음 (peak=${best})`);
      assert.ok(best <= 1.0, `${pid} 클리핑 (peak=${best})`);
    }
  });

  ok("모든 sf 드럼 킷의 등록 피스가 소리를 냄", () => {
    for (const [kid, preset] of Object.entries(SF_DRUM_KITS)) {
      if (preset.engine === "sfizz") continue;
      for (const piece of Object.keys(drumPieces(kid))) {
        const s = createSong({});
        s.tracks = [{ name: "d", preset: kid, volume: 0.9, pan: 0,
          notes: [{ bar: 1, beat: 0, pitch: piece, dur: 0.25, vel: 110 }] }];
        const r = renderRange(validateSong(s), 1, 1, { tail: 0.3 });
        let peak = 0;
        for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]));
        assert.ok(peak > 0.005, `${kid}/${piece} 무음 (peak=${peak})`);
      }
    }
  });

  ok("sf 렌더가 결정적", () => {
    const s = createSong({});
    s.tracks = [{ name: "p", preset: "sf-piano", volume: 0.8, pan: 0,
      notes: [{ bar: 1, beat: 0, pitch: "E4", dur: 1, vel: 90 }] }];
    const v = validateSong(s);
    const a = renderRange(v, 1, 1, { tail: 0.4 }), b = renderRange(v, 1, 1, { tail: 0.4 });
    assert.equal(a.left.length, b.left.length);
    for (let i = 0; i < a.left.length; i += 97) assert.equal(a.left[i], b.left[i], `샘플 ${i} 불일치`);
  });

  ok("sf velocity 다이내믹·velRange 오버라이드 동작", () => {
    const mk = (vel, extra = {}) => {
      const s = createSong({});
      s.tracks = [{ name: "p", preset: "sf-piano", volume: 0.8, pan: 0, ...extra,
        notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel }] }];
      return renderRange(validateSong(s), 1, 1, { tail: 0.4 });
    };
    const rms = r => { let s = 0; for (let i = 0; i < r.left.length; i++) s += r.left[i] ** 2; return Math.sqrt(s / r.left.length); };
    const spanDefault = 20 * Math.log10(rms(mk(120)) / rms(mk(30)));
    const spanWide = 20 * Math.log10(rms(mk(120, { velRange: 1 })) / rms(mk(30, { velRange: 1 })));
    assert.ok(spanDefault > 1, `기본 다이내믹이 없음 (${spanDefault.toFixed(1)}dB)`);
    assert.ok(spanWide > spanDefault + 3, `velRange:1이 폭을 안 넓힘 (${spanDefault.toFixed(1)} → ${spanWide.toFixed(1)}dB)`);
  });

  ok("sf 프리셋 MIDI 내보내기 — GM 프로그램·드럼 채널", () => {
    const s = createSong({});
    s.tracks = [
      { name: "P", preset: "sf-piano", volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 }] },
      { name: "D", preset: "sf-kit", volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "kick", dur: 0.25, vel: 100 }] }
    ];
    const buf = midiBuffer(validateSong(s));
    assert.ok(buf.includes(Buffer.from([0xc0, 0x00])), "피아노 프로그램 체인지(ch0, gm0) 없음");
    assert.ok(buf.includes(Buffer.from([0x99, 36, 100])), "드럼이 채널 10(0x99)의 GM 킥(36)으로 안 나감");
  });
}

console.log(`통과 ${passed}건 — 문제 없음`);
