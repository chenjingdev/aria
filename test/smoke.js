// aria — 스모크 테스트: 모델·렌더·파일 형식 무결성
import assert from "node:assert";
import { createSong, validateSong, noteToMidi, totalBars, songText } from "../src/song.js";
import { renderRange, wavBuffer } from "../src/synth.js";
import { midiBuffer } from "../src/midi.js";
import { TEMPLATES, PRESETS, DRUM_KITS, DRUM_PIECES } from "../src/presets.js";

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
song.tracks[0].notes = [ // Drums (lofi-kit)
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
  assert.ok(duration > 4.9 && duration < 8, `duration=${duration}`); // 2마디(5초) + 꼬리
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

ok("모든 템플릿·프리셋이 유효", () => {
  for (const id of Object.keys(TEMPLATES)) {
    const s = createSong({ template: id });
    validateSong(s);
    assert.ok(s.tracks.length >= 3, `${id} 트랙 부족`);
  }
});

ok("모든 멜로디 프리셋이 소리를 냄", () => {
  for (const pid of Object.keys(PRESETS)) {
    const s = createSong({});
    s.tracks = [{ name: "t", preset: pid, volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 100 }] }];
    const r = renderRange(validateSong(s), 1, 1, { tail: 0.5 });
    let peak = 0;
    for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]));
    assert.ok(peak > 0.01, `${pid} 무음 (peak=${peak})`);
  }
});

ok("모든 드럼 피스가 소리를 냄", () => {
  for (const kid of Object.keys(DRUM_KITS)) {
    for (const piece of Object.keys(DRUM_PIECES)) {
      const s = createSong({});
      s.tracks = [{ name: "d", preset: kid, volume: 0.9, pan: 0, notes: [{ bar: 1, beat: 0, pitch: piece, dur: 0.25, vel: 110 }] }];
      const r = renderRange(validateSong(s), 1, 1, { tail: 0.3 });
      let peak = 0;
      for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]));
      assert.ok(peak > 0.01, `${kid}/${piece} 무음 (peak=${peak})`);
    }
  }
});

// ---------- 리뷰에서 확정된 결함의 회귀 테스트 ----------
// core.js를 로드하기 전에 자동 저장 경로를 격리 — 실제 ~/.aria/song.json을 오염시키지 않는다
process.env.ARIA_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/aria-smoke-${process.pid}`;
const { state, ops, runOp, subscribe, addLog } = await import("../src/core.js");

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
  s.tracks = [{ name:"현악", preset:"strings", volume:0.8, pan:0, notes:[
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
    ({ name: `t${i}`, preset: "pluck", volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 90 }] }));
  assert.throws(() => midiBuffer(validateSong(s)), /15개/);
});

ok("루프용 tail:0 렌더는 구간 길이와 일치", () => {
  const r = renderRange(validateSong(song), 1, 2, { tail: 0 });
  assert.ok(Math.abs(r.duration - r.rangeSec) < 0.01, `duration=${r.duration} rangeSec=${r.rangeSec}`);
});

ok("과도한 렌더 구간 거부", () => {
  const s = createSong({});
  s.bpm = 20; // 999마디 × 4박 × 3초 ≈ 3.3시간 — 상한(10분)을 확실히 넘긴다
  s.tracks = [{ name: "t", preset: "pluck", volume: 0.8, pan: 0, notes: [{ bar: 999, beat: 0, pitch: "C4", dur: 1, vel: 90 }] }];
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
const oneNote = (over = {}, vel = 100, preset = "organ", dur = 1) => validateSong({
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
  const base = ratio({});                 // 기본 0.65 → 약 2.1배
  const wide = ratio({ velRange: 1 });    // 1.0 → 약 6.0배
  assert.ok(base > 1.8 && base < 2.6, `기본 폭이 예상 밖: ${base.toFixed(2)}배`);
  assert.ok(wide > 5 && wide < 7, `velRange:1 폭이 예상 밖: ${wide.toFixed(2)}배`);
  assert.ok(wide / base > 2.5, `velRange가 폭을 못 넓힘 (${base.toFixed(2)}→${wide.toFixed(2)})`);
});

ok("velRange:0이면 velocity가 음량에 영향을 주지 않는다", () => {
  const loud = peakOf(renderRange(oneNote({ velRange: 0 }, 127), 1, 1, { tail: 0.4 }).left);
  const soft = peakOf(renderRange(oneNote({ velRange: 0 }, 1), 1, 1, { tail: 0.4 }).left);
  assert.ok(Math.abs(loud - soft) / loud < 0.01, `vel 1과 127의 차이가 남아 있음 (${soft} vs ${loud})`);
});

ok("release 오버라이드가 여운을 늘린다", () => {
  const tailRms = over => {
    const r = renderRange(oneNote(over, 100, "organ", 1), 1, 1, { tail: 1.6 });
    return rms(r.left, Math.round(0.7 * r.sr), Math.round(1.6 * r.sr)); // 게이트(0.5초) 한참 뒤
  };
  const dry = tailRms({}), wet = tailRms({ release: 2.0 });
  assert.ok(wet > dry * 5, `release가 여운을 못 늘림 (${dry.toExponential(2)} → ${wet.toExponential(2)})`);
});

ok("attack 오버라이드가 시작을 부드럽게 한다", () => {
  const early = over => {
    const r = renderRange(oneNote(over, 100), 1, 1, { tail: 0.4 });
    return rms(r.left, 0, Math.round(0.01 * r.sr)); // 첫 10ms
  };
  const fast = early({}), slow = early({ attack: 0.5 });
  assert.ok(slow < fast * 0.2, `attack이 반영 안 됨 (${fast.toExponential(2)} → ${slow.toExponential(2)})`);
});

ok("reverb 오버라이드가 트랙별로 먹는다", () => {
  const wetTail = over => {
    const r = renderRange(oneNote(over, 100, "pluck", 0.25), 1, 1, { tail: 1.6 });
    return rms(r.left, Math.round(1.0 * r.sr), r.left.length);
  };
  assert.ok(wetTail({ reverb: 0.9 }) > wetTail({ reverb: 0 }) * 10, "리버브 센드가 반영되지 않음");
});

ok("리버브가 좌우로 퍼진다 — 잔향이 모노로 뭉치지 않음", () => {
  const r = renderRange(oneNote({ reverb: 0.9 }, 100, "pluck", 0.25), 1, 1, { tail: 1.6 });
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
  ops.set_track({ track: "Keys", release: 1.5, velRange: 1, reverb: 0.7 });
  const t = () => state.song.tracks.find(x => x.name === "Keys");
  assert.equal(t().release, 1.5);
  assert.equal(t().velRange, 1);
  ops.set_track({ track: "Keys", release: null });
  assert.equal(t().release, undefined, "null은 프리셋 기본값으로 되돌려야 함");
  assert.equal(t().velRange, 1, "다른 항목은 유지");
  assert.throws(() => ops.set_track({ track: "Keys", release: 99 }), /release/);
  assert.equal(t().velRange, 1, "실패가 상태를 오염시키지 않음");
});

const fsMod = await import("node:fs");

ok("긴 곡도 구간을 나눠 WAV로 내보낼 수 있다", () => {
  const s = createSong({ bpm: 60 });          // 4박 × 1초 = 마디당 4초
  s.tracks = [{ name: "t", preset: "pluck", volume: 0.8, pan: 0, notes: [] }];
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

ok("긴 release가 잘리지 않는다 — 꼬리가 릴리즈를 담는다", () => {
  const s = oneNote({ release: 8 }, 100, "organ", 1);
  const r = renderRange(s, 1, 1);
  const tailPeak = peakOf(r.left.slice(-200));
  assert.ok(tailPeak < peakOf(r.left) * 0.01,
    `파일 끝이 하드컷됨 (마지막 피크가 전체의 ${(100 * tailPeak / peakOf(r.left)).toFixed(1)}%)`);
});

ok("긴 attack이 노트를 잘라먹지 않는다", () => {
  const step = buf => { let m = 0; for (let i = 1; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i] - buf[i-1])); return m; };
  // 게이트(0.25초)보다 긴 어택이 와도 노트가 온전히 울려야 한다 — 예전에는 버퍼가 어택을 못 담아 통째로 잘렸다
  const ref = peakOf(renderRange(oneNote({}, 100, "organ", 0.5), 1, 1).left);
  for (const attack of [0.5, 1, 2]) {
    const r = renderRange(oneNote({ attack }, 100, "organ", 0.5), 1, 1);
    assert.ok(peakOf(r.left) >= ref * 0.95,
      `attack=${attack}에서 노트가 잘림 (peak ${peakOf(r.left).toFixed(4)} < 기본 ${ref.toFixed(4)})`);
    assert.ok(step(r.left) < 0.03, `attack=${attack}에서 단차(클릭) ${step(r.left).toFixed(4)}`);
  }
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
      tracks: [{ name: "p", preset: "soft-piano", volume: 0.8, pan: 0, notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 1, vel: 96 }] }]
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
  assert.throws(() => oneNote({ release: 9 }), /release/);
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
const { sf2Available, SF2_PATH, parseSf2 } = await import("../src/sf2.js");
const { SF_PRESETS, SF_DRUM_KITS } = await import("../src/presets.js");

if (!sf2Available()) {
  console.log(`  (건너뜀) 사운드폰트 없음 — ${SF2_PATH}`);
} else {
  ok("sf2 파싱 — GM 프리셋·드럼 뱅크 존재", () => {
    const sf = parseSf2(SF2_PATH);
    assert.ok(sf.presets.size >= 100, `프리셋 ${sf.presets.size}개뿐`);
    for (const [, p] of Object.entries(SF_PRESETS))
      assert.ok(sf.presets.has(p.gm), `GM ${p.gm} 프리셋이 사운드폰트에 없음`);
    assert.ok(sf.presets.has(128 << 8), "GM 드럼 뱅크(128) 없음");
  });

  ok("모든 sf 멜로디 프리셋이 자기 음역에서 소리를 냄", () => {
    // C4 하나로만 재면 안 된다 — 콘트라베이스에 C4는 실제 악기 음역 밖이라 샘플이 없다.
    // (37개 중 24개가 어느 옥타브에선가 무음이다. 악기가 원래 그런 것이고, 여기서 볼 것은
    //  "이 프리셋이 자기 음역 어딘가에서는 제대로 소리를 내는가"다)
    for (const pid of Object.keys(SF_PRESETS)) {
      let best = 0, bad = 0;
      for (const pitch of ["C2", "C3", "C4", "C5"]) {
        const s = createSong({});
        s.tracks = [{ name: "t", preset: pid, volume: 0.8, pan: 0,
          notes: [{ bar: 1, beat: 0, pitch, dur: 1, vel: 100 }] }];
        const r = renderRange(validateSong(s), 1, 1, { tail: 0.5 });
        for (let i = 0; i < r.left.length; i++) {
          if (!Number.isFinite(r.left[i])) bad++;
          best = Math.max(best, Math.abs(r.left[i]));
        }
      }
      assert.equal(bad, 0, `${pid} NaN`);
      assert.ok(best > 0.01, `${pid} C2~C5 어디서도 무음 (peak=${best})`);
      assert.ok(best <= 1.0, `${pid} 클리핑 (peak=${best})`);
    }
  });

  ok("sf-kit 모든 피스가 소리를 냄", () => {
    for (const piece of Object.keys(DRUM_PIECES)) {
      const s = createSong({});
      s.tracks = [{ name: "d", preset: "sf-kit", volume: 0.9, pan: 0,
        notes: [{ bar: 1, beat: 0, pitch: piece, dur: 0.25, vel: 110 }] }];
      const r = renderRange(validateSong(s), 1, 1, { tail: 0.3 });
      let peak = 0;
      for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]));
      assert.ok(peak > 0.005, `sf-kit/${piece} 무음 (peak=${peak})`);
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
